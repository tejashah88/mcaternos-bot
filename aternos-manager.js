const fs = require('fs');
const EventEmitter = require('events').EventEmitter;

const { setIntervalAsync } = require('set-interval-async/fixed');
const { clearIntervalAsync } = require('set-interval-async');

const deepEqual = require('deep-equal');
const puppeteer = require('puppeteer');
const pidusage = require('pidusage');
const delay = require('delay');

const ATERNOS_HOME_URL          = 'https://aternos.org/:en/';
const ATERNOS_LOGIN_URL         = 'https://aternos.org/go/';
const ATERNOS_SERVER_SELECT_URL = 'https://aternos.org/servers/';
const ATERNOS_CONSOLE_URL       = 'https://aternos.org/server/';

const STATUS_UPDATE_INTERVAL = 1000;               // 1 second
const MAX_MEMORY_ALLOWED = 2 * 1024 * 1024 * 1024; // 2 GB

const MAINTAINANCE_LOCK_FILE = 'maintainance.lock';

const AternosStatus = {
    ONLINE:    'online',
    OFFLINE:   'offline',
    STARTING:  'starting ...',
    LOADING:   'loading ...',
    PREPARING: 'preparing ...',
    IN_QUEUE:  'waiting in queue',
    SAVING:    'saving ...',
    STOPPING:  'stopping ...',
    CRASHED:   'crashed'
}

const ManagerStatus = {
    INITIALIZING: 1,
    READY:        2,
    RESTARTING:   4,
    STOPPING:     8,
}

// Source: https://stackoverflow.com/a/16608045
isArray = (x) => (!!x) && (x.constructor === Array);
isObject = (x) => (!!x) && (x.constructor === Object)

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

class StatusTracker extends EventEmitter {
    constructor(eventName, { initial = null, deep = false, allowed = true } = {}) {
        super();

        this.eventName = eventName;
        this.deepStatus = deep;
        this.allowedValues = allowed;

        this.currentStatus = initial;
        this.prevStatus = null;
    }

    set(newStatus, forceUpdate = false) {
        const arrayCheckFail = isArray(this.allowedValues) && !this.allowedValues.includes(newStatus);
        const objectCheckFail = isObject(this.allowedValues) && !Object.values(this.allowedValues).includes(newStatus);
        
        if (arrayCheckFail || objectCheckFail)
            throw new Error(`Status tracker of event '${this.eventName}' received invalid status '${newStatus}'`);

        this.prevStatus = this.currentStatus;
        this.currentStatus = newStatus;

        if (!this.deepStatus) {
            if (forceUpdate || this.currentStatus != this.prevStatus)
                this.emit(this.eventName, this.currentStatus, this.prevStatus, forceUpdate);
        } else {
            if (forceUpdate || !deepEqual(this.currentStatus, this.prevStatus))
                this.emit(this.eventName, this.currentStatus, this.prevStatus, forceUpdate);
        }
    }

    get() {
        return this.currentStatus;
    }

    forceUpdate() {
        this.set(this.currentStatus, true);
    }

    addHook(fn) {
        this.on(this.eventName, fn);
    }

    removeHook(fn) {
        this.off(this.eventName, fn);
    }

    removeAllHooks() {
        this.removeAllListeners(this.eventName);
    }
}

class AternosManager {
    constructor(options) {
        this.console = null;
        this.statusLoop = null;

        this.url = options.server;
        this.user = options.username;
        this.pass = options.password;

        this.serverStatus = new StatusTracker('serverStatus', { allowed: AternosStatus });
        this.fullServerStatus = new StatusTracker('fullServerStatus', { deep: true });
        this.maintainanceStatus = new StatusTracker('maintainanceStatus', { allowed: [true, false] });
        this.managerStatus = new StatusTracker('managerStatus', { allowed: ManagerStatus });

        this.maintainanceStatus.addHook(async (onMaintainance) => {
            await fs.promises.writeFile(MAINTAINANCE_LOCK_FILE, onMaintainance);
        })
    }

    async initialize() {
        this.managerStatus.set(ManagerStatus.INITIALIZING);

        if (!this.browser)
            this.browser = await puppeteer.launch({ handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });

        await this.login(this.user, this.pass);
        await this.selectServerFromList();

        if (fs.existsSync(MAINTAINANCE_LOCK_FILE)) {
            const contents = await fs.promises.readFile(MAINTAINANCE_LOCK_FILE, 'utf-8');
            this.toggleMaintainance(contents == 'true');
            console.log(`Konsole: Starting in ${this.maintainanceStatus.get() ? 'maintainance' : 'production'} mode!`);
        }

        // Call this once to ensure that we have a status reading of the server
        await this.checkStatus(true);

        console.log('Konsole: Starting status and memory scanning loop...');
        this.statusLoop = setIntervalAsync(async () => {
            await this.checkStatus();
            await this.checkMemoryUsage();
        }, STATUS_UPDATE_INTERVAL);

        this.managerStatus.set(ManagerStatus.READY);
    }

    async cleanup(restarting = false) {
        if (restarting) {
            console.log('Konsole: Restarting console page...');
            this.managerStatus.set(ManagerStatus.RESTARTING);
        } else {
            console.log('Konsole: Stopping console page...');
            this.managerStatus.set(ManagerStatus.STOPPING);
        }

        if (this.statusLoop != null) {
            await clearIntervalAsync(this.statusLoop);
            console.log('Konsole: Stopped status and memory scanning loop!');
        }

        if (!restarting)
            this.removeAllListeners();

        if (this.console != null) {
            this.console.close();
            this.console = null;
        }

        if (this.browser != null) {
            this.browser.close();
            this.browser = null;
        }
    }

    removeAllListeners() {
        this.serverStatus.removeAllHooks();
        this.fullServerStatus.removeAllHooks();
        this.maintainanceStatus.removeAllHooks();
        this.managerStatus.removeAllHooks();
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
            errorMsg = await this.console.$eval('.login-error', elem => elem.textContent.trim());
        } catch (err) {
            // NOTE: Error is ignored because the tab has teleported to a new URL and it can't find the 'login-error' element
        }

        if (!errorMsg)
            console.log('Konsole: Successfully logged in!');
        else
            throw new AternosException(errorMsg);
    }

    toggleMaintainance(newVal) {
        this.maintainanceStatus.set(newVal);
    }

    isInMaintainance() {
        return this.maintainanceStatus.get();
    }

    hasCrashed() {
        return this.serverStatus.get() == AternosStatus.CRASHED;
    }

    isReady() {
        return this.managerStatus.get() == ManagerStatus.READY;
    }

    async checkStatus(forceUpdate) {
        if (this.managerStatus.get() != ManagerStatus.READY)
            return;

        const results = await this.console.evaluate(() => {
            const $cleanedText = selector => document.querySelector(selector).textContent.trim();
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

        this.serverStatus.set(results.serverStatus);
        this.fullServerStatus.set(results);

        return results;
    }

    browserPID() {
        return this.browser.process().pid;
    }

    async checkMemoryUsage() {
        const usageStats = await pidusage(this.browserPID());
        if (usageStats.memory > MAX_MEMORY_ALLOWED) {
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
            return elems.map(e => e.textContent.trim() == targetUrl.split('.').shift()).indexOf(true);
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

    requestStartServer() {
        let that = this;

        async function attemptStartServer(currInternalStatus) {
            // This is for the edge case when the user is requesting to start the server when the bot isn't ready
            if (that.isReady()) {
                await that.console.click('#start');
                that.managerStatus.removeHook(attemptStartServer);

                // Hide notifications alert after 1 second
                await delay(1000);
                await that.console.evaluate(() => hideAlert());
            }
        }

        this.managerStatus.addHook(attemptStartServer);
        this.managerStatus.forceUpdate();
    }
}

module.exports = { AternosManager, AternosStatus, AternosException, ManagerStatus };
