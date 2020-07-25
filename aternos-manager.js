const fs = require('fs');

const { setIntervalAsync } = require('set-interval-async/fixed');
const { clearIntervalAsync } = require('set-interval-async');

const puppeteer = require('puppeteer');
const pidusage = require('pidusage');
const delay = require('delay');
const cron = require('node-cron');

// Initialize libraries and variables
const CONFIG_FILE = './config.ini';
const ini = require('ini');
const config = ini.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));

const { StatusTrackerMap } = require('./status-tracker');

const ATERNOS_HOME_URL          = 'https://aternos.org/:en/';
const ATERNOS_LOGIN_URL         = 'https://aternos.org/go/';
const ATERNOS_SERVER_SELECT_URL = 'https://aternos.org/servers/';
const ATERNOS_CONSOLE_URL       = 'https://aternos.org/server/';
const ATERNOS_BACKUP_URL        = 'https://aternos.org/backups/';

const STATUS_UPDATE_INTERVAL = 5000;               // 5 seconds
const MAX_MEMORY_ALLOWED = 2 * 1024 * 1024 * 1024; // 2 GB
const DEFAULT_STATUS_LOGIC_WAIT = 30000;           // 30 seconds
const BACKUP_CRON_STRING = '0 */2 * * *';          // every two hours

const MAINTENANCE_LOCK_FILE = 'maintenance.lock';

const AternosStatus = {
    ONLINE:     'online',
    OFFLINE:    'offline',
    STARTING:   'starting ...',
    LOADING:    'loading ...',
    PREPARING:  'preparing ...',
    IN_QUEUE:   'waiting in queue',
    SAVING:     'saving ...',
    STOPPING:   'stopping ...',
    CRASHED:    'crashed',
    RESTARTING: 'restarting ...',
};

const ManagerStatus = {
    INITIALIZING: 1,
    READY:        2,
    RESTARTING:   4,
    STOPPING:     8,
};

const ServerActions = {
    START:   1,
    STOP:    2,
    RESTART: 4,
};

// Source: https://gist.github.com/slavafomin/b164e3e710a6fc9352c934b9073e7216
class AternosException extends Error {
    constructor (message, status) {
        // Calling parent constructor of base Error class.
        super(message);

        // Saving class name in the property of our custom error as a shortcut.
        this.name = this.constructor.name;

        // Capturing stack trace, excluding constructor call from it.
        Error.captureStackTrace(this, this.constructor);
    }
}

class AternosManager extends StatusTrackerMap {
    constructor(options) {
        super();

        this.console = null;
        this.backupPage = null;
        this.statusLoop = null;
        this.backupCron = null;

        this.url = options.server;
        this.user = options.username;
        this.pass = options.password;

        this.addTracker('serverStatus', { allowed: AternosStatus });
        this.addTracker('fullServerStatus', { deep: true });
        this.addTracker('maintenanceStatus', { allowed: [true, false] });
        this.addTracker('managerStatus', { allowed: ManagerStatus });

        this.addHook('maintenanceStatus', async maintenance => {
            await fs.promises.writeFile(MAINTENANCE_LOCK_FILE, maintenance);
        });
    }

    async initialize() {
        this.setStatus('managerStatus', ManagerStatus.INITIALIZING);

        if (!this.browser) {
            this.browser = await puppeteer.launch({
                headless: true,
                handleSIGINT: false,
                handleSIGTERM: false,
                handleSIGHUP: false
            });
        }

        await this.login(this.user, this.pass);
        await this.selectServerFromList();

        // Call this once to ensure that we have a status reading of the server
        await this.checkStatus(true);

        // Setup backups page for commands and auto-backup
        this.backupPage = await this.browser.newPage();
        await this.backupPage.goto(ATERNOS_BACKUP_URL);
        await this.backupPage.waitForSelector('.backups');
        await this.listBackups();

        console.log('Konsole: Starting status and memory scanning loop...');
        if (!this.statusLoop) {
            this.statusLoop = setIntervalAsync(async () => {
                await this.checkStatus();
                await this.checkMemoryUsage();
            }, STATUS_UPDATE_INTERVAL);
        }

        if (!this.backupCron) {
            this.backupCron = cron.schedule(BACKUP_CRON_STRING, (function (that) {
                that.generateAutoBackupWhileOnline(that);
            })(this), { scheduled: false });
        }

        console.log('Konsole: Starting backup cron for every 2 hours...');
        this.backupCron.start();

        // Set maintenance mode
        if (fs.existsSync(MAINTENANCE_LOCK_FILE)) {
            const contents = await fs.promises.readFile(MAINTENANCE_LOCK_FILE, 'utf-8');
            this.toggleMaintenance(contents == 'true');
            console.log(`Konsole: Starting in ${this.getStatus('maintenanceStatus') ? 'maintenance' : 'production'} mode!`);
        }

        this.setStatus('managerStatus', ManagerStatus.READY);
    }

    async cleanup(restarting = false) {
        if (restarting) {
            console.log('Konsole: Restarting console page...');
            this.setStatus('managerStatus', ManagerStatus.RESTARTING);
            if (!!this.backupCron)
                this.backupCron.stop();
        } else {
            console.log('Konsole: Stopping console page...');
            this.setStatus('managerStatus', ManagerStatus.STOPPING);
            if (!!this.backupCron)
                this.backupCron.destroy();
        }

        if (this.statusLoop != null) {
            await clearIntervalAsync(this.statusLoop);
            console.log('Konsole: Stopped status and memory scanning loop!');
        }

        if (!restarting)
            this.removeAllListeners();

        if (this.browser != null) {
            await this.browser.close();
            this.browser = null;
        }
    }

    removeAllListeners() {
        this.removeAllTrackers();
    }

    async isLoggedIn() {
        if (!this.browser || !this.console)
            return false;

        const currentUrl = this.console.url();
        return currentUrl == ATERNOS_CONSOLE_URL;
    }

    async login(user, pass) {
        if (await this.isLoggedIn())
            return;

        console.log('Konsole: Logging into Aternos console...');

        this.console = await this.browser.newPage();
        await this.console.goto(ATERNOS_HOME_URL);
        await this.console.waitForSelector('.splash');

        await Promise.all([
            this.console.click('.mod-signup'),
            this.console.waitForNavigation()
        ]);

        // Type in the credentials and try to login
        await this.console.type('#user', user);
        await this.console.type('#password', pass);

        await this.console.click('#login');
        await this.console.waitForResponse(res => res.url().includes('login.php'));

        // Added short delay in case page doesn't teleport right away
        await delay(1000);

        let errorMsg = null;
        try {
            errorMsg = await this.console.$eval('.login-error', elem => elem.innerText);
        } catch (err) {
            // NOTE: Error is ignored because the tab has teleported to a new URL and it can't find the 'login-error' element
        }

        if (!errorMsg)
            console.log('Konsole: Successfully logged in!');
        else
            throw new AternosException(errorMsg);
    }

    toggleMaintenance(newVal) {
        this.setStatus('maintenanceStatus', newVal);
    }

    isInMaintenance() {
        return !!this.getStatus('maintenanceStatus');
    }

    hasCrashed() {
        return this.getStatus('serverStatus') == AternosStatus.CRASHED;
    }

    isReady() {
        return this.getStatus('managerStatus') == ManagerStatus.READY;
    }

    async checkStatus(forceUpdate = false) {
        if (this.getStatus('managerStatus') != ManagerStatus.READY)
            return;

        const results = await this.console.evaluate(() => {
            const $cleanedText = selector => document.querySelector(selector).innerText;
            const status      = $cleanedText('.statuslabel-label').toLowerCase();
            const playerCount = $cleanedText('#players');
            const qTime       = $cleanedText('.queue-time').toLowerCase();
            const qPosition   = $cleanedText('.queue-position').toLowerCase();

            return {
                serverStatus: status,
                playersOnline: playerCount,
                queueEta: qTime,
                queuePos: qPosition
            };
        });

        this.setStatus('serverStatus', results.serverStatus, forceUpdate);
        this.setStatus('fullServerStatus', results, forceUpdate);

        return results;
    }

    browserPID() {
        return this.browser.process().pid;
    }

    async checkMemoryUsage() {
        const usageStats = await pidusage(this.browserPID());
        if (usageStats.memory > MAX_MEMORY_ALLOWED) {
            console.log('Konsole: Restarting to free memory...');
            await this.cleanup(true);
            await this.initialize();
        }
    }

    async getServerIP() {
        return await this.console.$eval('.server-ip', e => e.innerText.trim().split(/\s/g)[0]);
    }

    async clickConfirmNowIfNeeded() {
        // Source: https://stackoverflow.com/a/14122186
        const needToConfirm = await this.console.$eval('#confirm', e => e.offsetWidth !== 0 && e.offsetHeight !== 0);
        if (needToConfirm)
            await this.console.click('#confirm');
    }
 
    async selectServerFromList() {
        if (this.console.url() != ATERNOS_SERVER_SELECT_URL)
            throw new AternosException('You must be on server select URL in order to select the right server');

        console.log('Konsole: Selecting correct server from list...');

        await this.console.waitForSelector('.page-servers');

        // Select the correct server from the list
        const serverIndex = await this.console.$$eval('.server-name', (elems, targetUrl) => {
            return elems.map(e => e.innerText == targetUrl.split('.').shift()).indexOf(true);
        }, this.url);

        if (serverIndex == -1)
            throw new AternosException('Unable to locate target server on Aternos console!');

        // Access that server
        const targetServerPanel = await this.console.$(`.server:nth-child(${serverIndex + 1})`);
        await Promise.all([
            targetServerPanel.click(),
            this.console.waitForNavigation()
        ]);

        // Wait for page to load
        console.log(`Konsole: Successfully changed server IP to ${this.url}!`);
    }

    async startServer() {
        await this.console.click('#start');

        // The notifications alert will pop up whenever the server starting is in queue and it'll prevent
        // the bot from confirming the starting process, so it'll try to close it
        await delay(1000);
        await this.console.evaluate(() => hideAlert());
        await delay(1000);
        
        // Wait until we know for sure that the server is indeed starting up before letting go
        await this.waitForStatusLogic(
            'serverStatus',
            newStatus => ![AternosStatus.OFFLINE, AternosStatus.CRASHED].includes(newStatus),
            DEFAULT_STATUS_LOGIC_WAIT
        );
    }

    async stopServer() {
        await this.console.click('#stop');
        
        // Wait until we know for sure that the server is indeed shutting down before letting go
        await this.waitForStatusLogic(
            'serverStatus',
            newStatus => newStatus != AternosStatus.OFFLINE,
            DEFAULT_STATUS_LOGIC_WAIT
        );
    }

    async restartServer() {
        await this.console.click('#restart');
        
        // Wait until we know for sure that the server is indeed shutting down before letting go
        await this.waitForStatusLogic(
            'serverStatus',
            newStatus => newStatus != AternosStatus.ONLINE,
            DEFAULT_STATUS_LOGIC_WAIT
        );
    }

    async listBackups() {
        await this.backupPage.reload({ waitUntil: ['domcontentloaded'] });

        const quotaUsage = await this.backupPage.$eval('.backup-quota-usage', elem => elem.innerText);
        const backupFiles = await this.backupPage.$$eval('.backups > .file', elems => {
            return elems.map(e => ({
                id: e.attributes.id.value.substring('backup-'.length),
                name: e.children[0].childNodes[0].textContent.trim(),
                datetime: e.children[0].childNodes[1].textContent.trim(),
                filesize: e.children[2].innerText,
            }));
        });

        return { quotaUsage, backupFiles };
    }

    async createBackup(backupName, {
        onRequestStart = function () {},
        onStart = function () {},
        onFinish = function () {},
        onFail = function () {}
    } = {}) {
        backupName = backupName.trim();
        if (backupName.length > 100) {
            await onFail('Backup name specified is longer than 100 characters!')
            return;
        }

        // Make sure that we only create a backup when the name is unique
        const { backupFiles } = await this.listBackups();
        if (backupFiles.filter(file => file.name == backupName).length > 0) {
            await onFail("You can't create another backup of the same name!");
            return;
        }

        await this.backupPage.type('#backup-create-input', backupName);

        await this.backupPage.click('#backup-create-btn');
        await onRequestStart();

        const cdp = await this.backupPage.target().createCDPSession();
        await cdp.send('Network.enable');
        await cdp.send('Page.enable');

        let startedBackup = false;
        async function processBackupProgress(wsPayload) {
            const payload = JSON.parse(wsPayload.response.payloadData);

            if (!!payload.type && payload.type == "backup_progress") {
                const msg = JSON.parse(payload.message);

                if (startedBackup === false) {
                    startedBackup = true;
                    await onStart();
                }

                if (msg.done === true) {
                    cdp.off('Network.webSocketFrameReceived', processBackupProgress);
                    await cdp.detach();
                    await onFinish();
                }
            }
        };

        cdp.on('Network.webSocketFrameReceived', processBackupProgress);
    }

    async _deleteBackupByIndex(backupIndex, { onStart = function () {}, onFinish = function () {}, onFail = function () {} } = {}) {
        await this.backupPage.waitForSelector('.backup-remove-btn');
        const allDeleteBtns = await this.backupPage.$$(`.backup-remove-btn`);
        await allDeleteBtns[backupIndex].click();

        await this.backupPage.click('.btn-green');
        await onStart();

        const that = this;
        async function detectBackupDeletionFinish(res) {
            if (res.url().includes('delete.php')) {
                if (res.ok()) {
                    try {
                        const body = await res.json();

                        if (body.success)
                            await onFinish();
                        else
                            await onFail(body.message);
                    } catch (err) {
                        await onFail('DEBUG: Unable to parse backup deletion status!');
                    }
                } else
                    await onFail('Backup deletion failed! Check if Aternos is still online and functioning?');

                that.backupPage.off('response', detectBackupDeletionFinish);
            }
        }

        this.backupPage.on('response', detectBackupDeletionFinish);
    }

    async deleteBackup(backupName, { onStart = function () {}, onFinish = function () {}, onFail = function () {} } = {}) {
        backupName = backupName.trim();
        const { backupFiles } = await this.listBackups();
        const backupIndex = backupFiles.findIndex(file => file.name == backupName);

        // Make sure that we only delete a backup when the name exists
        if (backupIndex == -1) {
            await onFail("You can't delete a backup whose name doesn't exist!");
            return;
        }

        await this._deleteBackupByIndex(backupIndex, { onStart, onFinish, onFail });
    }

    async deleteOldestBackup({ onStart = function () {}, onFinish = function () {}, onFail = function () {} } = {}) {
        const { backupFiles } = await this.listBackups();
        const lastBackupIndex = backupFiles.length - 1;
        await this._deleteBackupByIndex(lastBackupIndex, { onStart, onFinish, onFail });
    }

    async makeAutoBackup() {
        const dateOfBackup = new Date().toLocaleString().split(',')[0]; // Just the date in MM/DD/YYYY
        const dateHash = parseInt(+new Date / 1000).toString(16);       // A base-16 time-based hash based on number of seconds since start of epoch
        await this.createBackup(`Automatic backup @ ${dateOfBackup} - ${dateHash}`);
    }

    async pruneOldBackups() {
        let numBackups = (await this.listBackups()).backupFiles.length;
        const BACKUP_FILES_LIMIT = parseInt(config.aternos.BACKUP_LIMIT);

        while (numBackups > BACKUP_FILES_LIMIT) {
            await this.deleteOldestBackup();
            numBackups = (await this.listBackups()).backupFiles.length;
        }
    }

    async generateAutoBackupWhileOnline(that) {
        if (that.getStatus('serverStatus') == AternosStatus.ONLINE) {
            // Create auto-backup
            console.log('Konsole: Creating backup while server is online...');
            await that.makeAutoBackup();

            // Delete old-backups
            console.log('Konsole: Deleting oldest backup(s) to maintain backup limit...');
            await that.pruneOldBackups();
        }
    }
}

module.exports = { AternosManager, AternosException, AternosStatus, ManagerStatus, ServerActions };
