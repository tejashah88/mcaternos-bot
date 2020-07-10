const fs = require('fs');

const { setIntervalAsync } = require('set-interval-async/fixed');
const { clearIntervalAsync } = require('set-interval-async');

const puppeteer = require('puppeteer');
const pidusage = require('pidusage');
const delay = require('delay');

const { StatusTrackerMap } = require('./status-tracker');

const ATERNOS_HOME_URL          = 'https://aternos.org/:en/';
const ATERNOS_LOGIN_URL         = 'https://aternos.org/go/';
const ATERNOS_SERVER_SELECT_URL = 'https://aternos.org/servers/';
const ATERNOS_CONSOLE_URL       = 'https://aternos.org/server/';
const ATERNOS_BACKUP_URL        = 'https://aternos.org/backups/';

const STATUS_UPDATE_INTERVAL = 5000;               // 5 seconds
const MAX_MEMORY_ALLOWED = 2 * 1024 * 1024 * 1024; // 2 GB

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
        this.statusLoop = setIntervalAsync(async () => {
            await this.checkStatus();
            await this.checkMemoryUsage();
        }, STATUS_UPDATE_INTERVAL);

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
        } else {
            console.log('Konsole: Stopping console page...');
            this.setStatus('managerStatus', ManagerStatus.STOPPING);
        }

        if (this.statusLoop != null) {
            await clearIntervalAsync(this.statusLoop);
            console.log('Konsole: Stopped status and memory scanning loop!');
        }

        if (!restarting)
            this.removeAllListeners();

        if (this.backupPage != null) {
            await this.backupPage.close();
            this.backupPage = null;
        }

        if (this.console != null) {
            await this.console.close();
            this.console = null;
        }

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

    requestServerAction(serverAction) {
        const that = this;

        const action2Id = {
            [ServerActions.START]:   '#start',
            [ServerActions.STOP]:    '#stop',
            [ServerActions.RESTART]: '#restart',
        };

        async function attemptServerAction(managerStatus) {
            // This is for the edge case when the user is requesting to start the server when the bot isn't ready
            if (that.isReady()) {
                await that.console.click(action2Id[serverAction]);
                that.removeHook('managerStatus', attemptServerAction);

                if (serverAction == ServerActions.START) {
                    // Hide notifications alert after 1 second
                    await delay(1000);
                    await that.console.evaluate(() => hideAlert());
                }
            }
        }

        this.addHook('managerStatus', attemptServerAction);
        this.forceStatusUpdate('managerStatus');
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
            const { type, message: msgStr } = JSON.parse(wsPayload.response.payloadData);
            const msg = JSON.parse(msgStr);

            if (type == "backup_progress") {
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

    async _deleteBackupByIndex(backupIndex, { onStart = function () {}, onFinish = function () {} } = {}) {
        await this.backupPage.waitForSelector('.backup-remove-btn');
        const allDeleteBtns = await this.backupPage.$$(`.backup-remove-btn`);
        await allDeleteBtns[backupIndex].click();

        await onStart();

        await Promise.all([
            await this.backupPage.click('.btn-green'),
            this.backupPage.waitForNavigation({ waitUntil: ['domcontentloaded'], timeout: 60000 })
        ]);

        await onFinish();
    }

    async deleteBackup(backupName, { onStart = function () {}, onFinish = function () {}, onFail = function () {} } = {}) {
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
}

module.exports = { AternosManager, AternosException, AternosStatus, ManagerStatus, ServerActions };
