const fs = require('fs');
const EventEmitter = require('events').EventEmitter;

const interval = require('interval-promise');
const deepEqual = require('deep-equal');
const puppeteer = require('puppeteer');
const pidusage = require('pidusage');
const delay = require('delay');

const ATERNOS_HOME_URL          = 'https://aternos.org/:en/';
const ATERNOS_LOGIN_URL         = 'https://aternos.org/go/';
const ATERNOS_SERVER_SELECT_URL = 'https://aternos.org/servers/';
const ATERNOS_CONSOLE_URL       = 'https://aternos.org/server/';

const LOGIN_DELAY = 5 * 1000;                      // 5 seconds
const STATUS_UPDATE_INTERVAL = 3 * 1000;           // 3 seconds
const DELAY_BEFORE_CLEANUP = 5 * 1000;             // 5 seconds
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
        this.off(this.eventName);
    }
}

class AternosManager {
    constructor(options) {
        this.console = null;
        this.url = options.server;
        this.user = options.username;
        this.pass = options.password;

        this.serverStatus = new StatusTracker('serverStatus', { allowed: AternosStatus });
        this.fullServerStatus = new StatusTracker('fullServerStatus', { deep: true });
        this.maintainanceStatus = new StatusTracker('maintainanceStatus', { allowed: [true, false] });
        this.managerStatus = new StatusTracker('managerStatus', {
            initial: ManagerStatus.INITIALIZING,
            allowed: ManagerStatus
        });

        this.maintainanceStatus.addHook(async (onMaintainance) => {
            await fs.promises.writeFile(MAINTAINANCE_LOCK_FILE, onMaintainance);
        })

        this.managerStatus.set(ManagerStatus.INITIALIZING);
    }

    async initialize() {
        if (!this.browser)
            this.browser = await puppeteer.launch({ headless: !false });

        await this.login(this.user, this.pass);
        await this.selectServerFromList();

        if (fs.existsSync(MAINTAINANCE_LOCK_FILE)) {
            const contents = await fs.promises.readFile(MAINTAINANCE_LOCK_FILE, 'utf-8');
            this.toggleMaintainance(contents == 'true');
            console.log(`Konsole: Starting in ${this.maintainanceStatus.get() ? 'maintainance' : 'production'} mode!`);
        }

        // Call this once to ensure that we have a status reading of the server
        await this.checkStatus(true);

        interval(async (iter, stop) => {
            if ([ManagerStatus.STOPPING, ManagerStatus.RESTARTING].includes(this.managerStatus.get()))
                return stop();

            await this.checkStatus();
            await this.checkMemoryUsage();
        }, STATUS_UPDATE_INTERVAL)

        this.managerStatus.set(ManagerStatus.READY);
    }

    async cleanup(restarting = false) {
        this.managerStatus.set(restarting ? ManagerStatus.RESTARTING : ManagerStatus.STOPPING);

        // Wait 5 seconds for the interval to stop
        await delay(DELAY_BEFORE_CLEANUP);

        if (!restarting)
            this.removeAllListeners();

        this.console.close();
        this.console = null;

        this.browser.close();
        this.browser = null;
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

        // Wait for 3 seconds if there's an error
        try {
            await Promise.all([
                await this.console.click('#login'),
                await this.console.waitForNavigation({ timeout: LOGIN_DELAY })
            ]);

            // Login succeeded at this point
            console.log('Konsole: Successfully logged in!');
        } catch (err) {
            // Login failed
            let errorMsg = await this.console.$eval('.login-error', elem => elem.textContent.trim(), { timeout: 5000 });
            if (!errorMsg)
                errorMsg = 'An unknown error occurred when attempting to login to the console';
            throw new AternosException(errorMsg);
        }
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
            const qTime       = $cleanedText('.queue-time').toLowerCase().substring(4);
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

    async checkMemoryUsage() {
        const usageStats = await pidusage(this.browser.process().pid);
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
        const needToConfirm = await this.console.$eval('#confirm', e => e.offsetWidth === 0 && e.offsetHeight === 0);
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
            }
        }

        this.managerStatus.addHook(attemptStartServer);
        this.managerStatus.forceUpdate();
    }
}

module.exports = { AternosManager, AternosStatus, AternosException, ManagerStatus };
