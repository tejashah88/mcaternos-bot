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
const MAX_MEMORY_ALLOWED = 2 * 1024 * 1024 * 1024; // 2 GB
// const MAX_MEMORY_ALLOWED = 150 * 1024 * 1024; // 150 MB

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
    CRASHED:   'crashed',
    UNKNOWN:   null,
}

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

class AternosManager extends EventEmitter {
    constructor(options) {
        super();

        this.console = null;
        this.url = options.server;
        this.user = options.username;
        this.pass = options.password;

        this.currentStatus = null;
        this.lastStatus = null;

        this.maintainance = false;
        this.cleaningUp = false;
    }

    async initialize() {
        if (!this.browser)
            this.browser = await puppeteer.launch({ headless: !false });

        await this.login(this.user, this.pass);
        await this.selectServerFromList();

        if (fs.existsSync(MAINTAINANCE_LOCK_FILE)) {
            const contents = await fs.promises.readFile(MAINTAINANCE_LOCK_FILE, 'utf-8');
            await this.toggleMaintainance(contents == 'true');
            console.log(`Konsole: Starting in ${this.isInMaintainance() ? 'maintainance' : 'production'} mode!`);
        }

        // Call this once to ensure that we have a status reading of the server
        await this.checkStatus(true);

        interval(async (iter, stop) => {
            if (this.cleaningUp)
                return stop();

            await this.checkStatus();
        }, STATUS_UPDATE_INTERVAL)
    }

    async cleanup(removeListeners = true) {
        this.cleaningUp = true;

        if (removeListeners)
            this.removeAllListeners();

        this.console.close();
        this.console = null;

        this.browser.close();
        this.browser = null;
    }

    async isLoggedin() {
        if (!this.browser || !this.console)
            return false;

        const currentUrl = await this.console.url();
        return currentUrl == ATERNOS_CONSOLE_URL;
    }

    async login(user, pass) {
        if (await this.isLoggedin())
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

        // Wait for 5 seconds if there's an error
        await this.console.click('#login');
        await delay(LOGIN_DELAY);

        const currentUrl = this.console.url();
        if (currentUrl == ATERNOS_LOGIN_URL) {
            let errorMsg = await this.console.$eval('.login-error', elem => elem.textContent.trim(), { timeout: 5000 });
            if (!errorMsg)
                errorMsg = 'An unknown error occurred when attempting to login to the console';
            throw new AternosException(errorMsg)
        } else {
            console.log('Konsole: Successfully logged in!');
        }
    }

    async toggleMaintainance(newVal) {
        this.maintainance = newVal;
        await fs.promises.writeFile(MAINTAINANCE_LOCK_FILE, this.maintainance);
        this.emit('maintainanceUpdate', this.maintainance);
    }

    isInMaintainance() {
        return this.maintainance;
    }

    async checkStatus(forceUpdate) {
        if (!this.console || this.console.actionInProgress)
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

        this.lastStatus = this.currentStatus;
        this.currentStatus = results;

        if (this.currentStatus != null) {
            const currServerStatus = this.currentStatus.serverStatus;
            const lastServerStatus = (this.lastStatus == null) ? null : this.lastStatus.serverStatus;

            if (forceUpdate || (currServerStatus != lastServerStatus))
                this.emit('statusUpdate', currServerStatus, lastServerStatus);
            
            if (forceUpdate || !deepEqual(this.currentStatus, this.lastStatus))
                this.emit('fullStatusUpdate', this.currentStatus, this.lastStatus);
        }

        return results;
    }

    hasCrashed() {
        return this.currentStatus.serverStatus == AternosStatus.CRASHED;
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

        console.log('Selecting correct server from list...');

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

    async startServer() {
        await this.console.click('#start');
    }
}

module.exports = { AternosManager, AternosStatus, AternosException };
