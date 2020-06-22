const fs = require('fs');
const EventEmitter = require('events').EventEmitter;

const interval = require('interval-promise');
const Nick = require('nickjs');

const JQUERY_VERSION = '3.5.1';
const ATERNOS_HOME_URL = 'https://aternos.org/:en/';
const ATERNOS_LOGIN_URL = 'https://aternos.org/go/';
const ATERNOS_CONSOLE_URL = 'https://aternos.org/server/';

const MIN_RELOGIN_TIMEOUT = 10 * 60 * 1000;   // 10 minutes
const WAIT_TIME_BETWEEN_PAGES = 3 * 1000;     // 3 seconds
const STATUS_UPDATE_INTERVAL = 3 * 1000;      // 3 seconds

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
    constructor(url) {
        super();
        this.url = url;
        this.console = null;
        this.user = null;
        this.pass = null;

        this.currentStatus = null;
        this.lastStatus = null;

        this.maintainance = false;
        this.cleaningUp = false;

        this.nick = new Nick({
            printNavigation: !false,
            printResourceErrors: !false,
            printPageErrors: !false,
            printAborts: !false
        });
    }

    setLoginDetails(user, pass) {
        this.user = user;
        this.pass = pass;
    }

    async makeNewTab(url, waitForTag = false, injectJquery = false) {
        const tab = await this.nick.newTab();
        await tab.open(url);

        if (!!waitForTag)
            await tab.untilVisible(waitForTag);

        if (!!injectJquery)
            await tab.inject(`http://code.jquery.com/jquery-${JQUERY_VERSION}.min.js`);

        return tab;
    }

    async initialize() {
        if (fs.existsSync(MAINTAINANCE_LOCK_FILE)) {
            const contents = await fs.promises.readFile(MAINTAINANCE_LOCK_FILE, 'utf-8');
            await this.toggleMaintainance(contents == 'true');
            console.log(`Konsole: Starting in ${this.isInMaintainance() ? 'maintainance' : 'production'} mode!`);
        }

        await this.login(this.user, this.pass);
        await this.selectServerFromList();

        interval(async (iter, stop) => {
            if (this.cleaningUp)
                return stop();

            await this.checkStatus();
        }, STATUS_UPDATE_INTERVAL)
    }

    async cleanup() {
        this.cleaningUp = true;
        this.removeAllListeners();
        this.nick.exit();
    }

    async isLoggedin() {
        if (!this.console)
            return false;

        const currentUrl = await this.console.getUrl();
        return currentUrl == ATERNOS_CONSOLE_URL;
    }

    async login(user, pass) {
        if (await this.isLoggedin())
            return;

        console.log('Konsole: Logging into Aternos console...');

        this.console = await this.makeNewTab(ATERNOS_HOME_URL, '.splash', true);
        await this.console.click('.mod-signup');
        await this.console.wait(WAIT_TIME_BETWEEN_PAGES);

        // Type in the credentials and try to login
        await this.console.sendKeys('#user', user);
        await this.console.sendKeys('#password', pass);
        await this.console.click('#login');

        // Wait up to 3 seconds if an error occurs
        await this.console.wait(WAIT_TIME_BETWEEN_PAGES);

        const errorMsg = await this.console.evaluate((arg, callback) => {
            const errMsg = $('.login-error').text().trim();
            callback(null, errMsg);
        });

        if (!!errorMsg)
            throw new AternosException(errorMsg);

        console.log('Konsole: Successfully logged in!');
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

        const results = await this.console.evaluate((arg, callback) => {
            const status = $('.statuslabel-label').text().toLowerCase().trim();
            const playerCount = $('#players').text().trim();
            const qTime = $('.queue-time').text().toLowerCase().trim().substring(4);
            const qPosition = $('.queue-position').text().toLowerCase().trim();

            callback(null, {
                serverStatus: status,
                playersOnline: playerCount,
                queueEta: qTime,
                queuePos: qPosition
            });
        });

        this.lastStatus = this.currentStatus;
        this.currentStatus = results;

        if (this.currentStatus != null) {
            const currServerStatus = this.currentStatus.serverStatus;
            const lastServerStatus = (this.lastStatus == null) ? null : this.lastStatus.serverStatus;
            if (forceUpdate || currServerStatus != lastServerStatus) {
                this.emit('statusUpdate', currServerStatus, lastServerStatus);
                this.emit('fullStatusUpdate', this.currentStatus, this.lastStatus);
            }
        }

        return results;
    }

    hasCrashed() {
        return this.currentStatus == AternosStatus.CRASHED;
    }

    async getServerIP() {
        return await this.console.evaluate((arg, callback) => {
            const serverIP = $('.server-ip')[0].firstChild.textContent.trim()
            callback(null, serverIP);
        });
    }

    async clickConfirmNowIfNeeded() {
        await this.console.evaluate((arg, callback) => {
            const needToConfirm = $('#confirm').is(':visible');
            if (needToConfirm)
                $('#confirm').click();
            callback(null, null);
        });
    }

    async selectServerFromList() {
        await this.console.waitUntilVisible('.page-servers');

        // Selecte the correct server from the list
        const errorMsg = await this.console.evaluate((arg, callback) => {
            const targetName = arg.targetUrl.split('.').shift();
            const serverIndex = $('.server-name', '.servers').map(function() {
                return targetName == this.textContent.trim();
            }).toArray().indexOf(true);

            if (serverIndex < 0) {
                callback(null, 'Unable to locate server on Aternos console! Does this bot have access to the correct server on Aternos?');
            } else {
                // Access that server
                $('.server')[serverIndex].click();
                callback(null, null);
            }
        }, { 'targetUrl': this.url });

        if (!!errorMsg)
            throw new AternosException(errorMsg);

        // Wait for the page to load
        await this.console.wait(WAIT_TIME_BETWEEN_PAGES);
        await this.console.untilVisible('.server-status');

        console.log(`Konsole: Successfully changed server IP to ${this.url}!`);
    }

    async startServer() {
        if (this.currentStatus == 'offline')
            await this.console.click('#start');
    }
}

module.exports = { AternosManager, AternosStatus, AternosException };
