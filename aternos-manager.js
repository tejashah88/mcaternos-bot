const fs = require('fs');

const Nick = require('nickjs');

const JQUERY_VERSION = '3.5.1';
const ATERNOS_HOME_URL = 'https://aternos.org/:en/';
const ATERNOS_LOGIN_URL = 'https://aternos.org/go/';
const ATERNOS_CONSOLE_URL = 'https://aternos.org/server/';

const MIN_RELOGIN_TIMEOUT = 10 * 60 * 1000;   // 10 minutes
const WAIT_TIME_BETWEEN_PAGES = 3 * 1000;     // 3 seconds

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

class AternosManager {
    constructor(url) {
        this.url = url;
        this.console = null;
        this.user = null;
        this.pass = null;
        this.currentStatus = null;

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
        await this.login(this.user, this.pass);
        await this.changeServerIfNeeded();
    }

    async cleanup() {
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

    async checkStatus() {
        if (this.console.actionInProgress)
            return null;

        const results = await this.console.evaluate((arg, callback) => {
            const status = $('.statuslabel-label').text().toLowerCase().trim();
            const playerCount = $('#players').text().trim();
            const qTime = $('.queue-time').text().toLowerCase().trim().substring(4);
            const qPosition = $('.queue-position').text().toLowerCase().trim();
            callback(null, [status, playerCount, qTime, qPosition]);
        });

        this.currentStatus = results[0];
        return results;
    }

    async getServerIP() {
        const [playersOnline, serverIP] = await this.console.evaluate((arg, callback) => {
            const [pplOnline, ip] = $('.statusinfo').text().trim().replace(/[ \n]+/g, ' ').split(' ');
            callback(null, [pplOnline, ip]);
        });

        return serverIP;
    }

    async clickConfirmNowIfNeeded() {
        await this.console.evaluate((arg, callback) => {
            const needToConfirm = $('#confirm').is(':visible');
            if (needToConfirm)
                $('#confirm').click();
            callback(null, null);
        });
    }

    async changeServerIfNeeded() {
        let serverIP = await this.getServerIP();

        if (serverIP != this.url) {
            console.log(`Konsole: Changing server IP from ${serverIP}...`);

            // Switch to the target server
            const errorMsg = await this.console.evaluate((arg, callback) => {
                // First, figure out which server, if there are multiple
                const possibleServers = $('.friend-access-switch');
                const altServerIndex = possibleServers.map((index, element) => {
                    const url = element.textContent.trim().replace(/[ \n]+/g, ' ').split(' by ')[0];
                    return url == arg.targetUrl;
                }).toArray().indexOf(true);

                // Check that the server actually exists
                if (altServerIndex < 0) {
                    callback(null, 'Unable to locate server on Aternos console! Does this bot have access to the correct server on Aternos?');
                } else {
                    // Access that server
                    $('.friend-access-count-dropdown').click();
                    $('.friend-access-switch-icon-container')[altServerIndex].click();
                    callback(null, null);
                }
            }, { 'targetUrl': this.url });

            if (!!errorMsg)
                throw new AternosException(errorMsg);

            // Wait for the page to load
            await this.console.wait(WAIT_TIME_BETWEEN_PAGES);
            await this.console.untilVisible('.server-status');

            serverIP = await this.getServerIP();
            if (serverIP != this.url)
                throw AternosException('Unable to start server! Check that you have access to it.')

            console.log(`Konsole: Successfully changed server IP to ${this.url}!`);
        }
    }

    async startServer() {
        if (this.currentStatus == 'offline')
            await this.console.click('#start');
    }
}

module.exports = { AternosManager, AternosStatus, AternosException };
