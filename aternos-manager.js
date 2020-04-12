require('dotenv').config();
const ATERNOS_URL = process.env.ATERNOS_SERVER_URL;

const Nick = require('nickjs');
const nick = new Nick();

const JQUERY_VERSION = '3.4.1';
const ATERNOS_LOGIN_URL = 'https://aternos.org/go/';
const ATERNOS_CONSOLE_URL = 'https://aternos.org/server/';

const MIN_RELOGIN_TIMEOUT = 5 * 60 * 1000; // 10 minutes
const THROUGHOUT_LOGIN_CHECK = false;

async function makeNewTab(url, waitForTag = false, injectJquery = false) {
    const tab = await nick.newTab();
    await tab.open(url);

    if (!!waitForTag)
        await tab.untilVisible(waitForTag);

    if (!!injectJquery)
        await tab.inject(`http://code.jquery.com/jquery-${JQUERY_VERSION}.min.js`);

    return tab;
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
        this.lastLogin = -1;
    }

    async isLoggedin() {
        if (THROUGHOUT_LOGIN_CHECK) {
            const tab = await makeNewTab(ATERNOS_LOGIN_URL);

            await tab.wait(5000);
            const currentUrl = await tab.getUrl();

            await tab.close();

            return currentUrl == ATERNOS_CONSOLE_URL;
        } else {
            return (+new Date() - this.lastLogin) < MIN_RELOGIN_TIMEOUT;
        }
    }

    async login(user, pass) {
        if (!THROUGHOUT_LOGIN_CHECK && await this.isLoggedin())
            return;

        const tab = await makeNewTab(ATERNOS_LOGIN_URL, '.go-title', true);

        // Type in the credentials and try to login
        await tab.sendKeys('#user', user);
        await tab.sendKeys('#password', pass);
        await tab.click('#login');

        // Wait up to 5 seconds if an error occurs
        await tab.wait(5000);

        const errorMsg = await tab.evaluate((arg, callback) => {
            const errMsg = $('.login-error').text().trim();
            callback(null, errMsg);
        });

        await tab.close();

        if (!!errorMsg) {
            throw new AternosException(errorMsg);
        }

        this.lastLogin = +new Date();
    }

    async checkStatus() {
        const tab = await makeNewTab(this.url, '.status', true);

        const [serverStatus, playersOnline] = await tab.evaluate((arg, callback) => {
            const status = $('.status-label').text().trim().toLowerCase(); // either 'online' or 'offline'
            const pplOnline = $('.info-label')[0].textContent;
            callback(null, [status, pplOnline]);
        });

        await tab.close();

        return [serverStatus, playersOnline];
    }

    async startServer(needsServerSwitch) {
        const tab = await makeNewTab(ATERNOS_CONSOLE_URL, '.server-status', true);

        let [playersOnline, serverIP] = await tab.evaluate((arg, callback) => {
            const [pplOnline, ip] = $('.statusinfo').text().trim().replace(/[ \n]+/g, ' ').split(' ');
            callback(null, [pplOnline, ip]);
        });

        if (serverIP != this.url) {
            // Switch to the target server if needed

            const errorMsg = await tab.evaluate((arg, callback) => {
                // First, figure out which server, if there are multiple
                const possibleServers = $('.friend-access-switch');
                const altServerIndex = possibleServers.map((index, element) => {
                    const url = element.textContent.trim().replace(/[ \n]+/g, ' ').split(' by ')[0];
                    return url == arg.targetUrl;
                }).toArray().indexOf(true);

                // Check that the server actually exists
                if (altServerIndex < 0) {
                    callback(null, 'Unable to locate server on Aternos console! Does this bot have access to the proper server on Aternos?');
                } else {
                    // Access that server
                    $('.friend-access-count-dropdown').click();
                    $('.friend-access-switch-icon-container')[altServerIndex].click();
                    callback(null, null);
                }
            }, { 'targetUrl': this.url });

            if (!!errorMsg) {
                throw new AternosException(errorMsg);
            }

            // Wait for up to 5 seconds for the page to load
            await tab.wait(5000);
            await tab.untilVisible('.server-status');

            [playersOnline, serverIP] = await tab.evaluate((arg, callback) => {
                const [pplOnline, ip] = $('.statusinfo').text().trim().replace(/[ \n]+/g, ' ').split(' ');
                callback(null, [pplOnline, ip]);
            });
        }

        let [serverStatus, queueEta, queuePos] = await tab.evaluate((arg, callback) => {
            const status = $('.statuslabel-label').text().toLowerCase().trim();
            const queueTime = $('.queue-time').text().toLowerCase().trim().substring(4);
            const queuePosition = $('.queue-position').text().toLowerCase().trim();
            callback(null, [status, queueTime, queuePosition]);
        })

        let outputMsg;

        if (serverStatus == 'online') {
            outputMsg = `The server is already online with ${playersOnline} players!`;
        } else if (serverStatus == 'offline') {
            await tab.click('#start');
            // await tab.screenshot('help.png');

            // const content = await tab.getContent();
            // const fs = require('fs');
            // fs.writeFile('lol.html', content, (err) => {
            //     if (err) {
            //         console.error(err)
            //         return;
            //     }
            //     //file written successfully
            // });

            outputMsg = 'Success! The server is starting up and should be ready soon!';
        } else if (serverStatus == 'starting ...' || serverStatus == 'loading ...') {
            outputMsg = 'The server is already starting up!';
        } else if (serverStatus == 'waiting in queue') {
            outputMsg = `The server is in queue for starting up. ETA is ${queueTime} and we're in position ${queuePos}`;
        } else if (serverStatus == 'saving ...') {
            outputMsg = 'The server is shutting down!';
        } else {
            throw new AternosException(`Unknown status found when trying to start up server: ${serverStatus}`);
        }

        await tab.close();

        return outputMsg;
    }
}

// Global Aternos manager object
GlobalAternosManager = new AternosManager(ATERNOS_URL);

module.exports = { AternosManager, AternosException, GlobalAternosManager };
