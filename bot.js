// Source: https://www.sitepoint.com/discord-bot-node-js/

'use strict'

require('make-promises-safe');

// Initialize libraries and variables
const CONFIG_FILE = './config.ini';
const STATUS_UPDATE_INTERVAL = 3 * 1000;

const fs = require('fs');
const ini = require('ini');
const config = ini.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));

const diehard = require('diehard');
const interval = require('interval-promise');

const Discord = require('discord.js');
const bot = new Discord.Client();

const { AternosManager, AternosStatus, AternosException } = require('./aternos-manager');

let isShuttingDown = false;

// Totally not a KDE reference :P
const Konsole = new AternosManager(config.aternos.SERVER_URL)
Konsole.setLoginDetails(config.aternos.ATERNOS_USER, config.aternos.ATERNOS_PASS);

// Command definitions
const BOT_CMDS = {
    StartServer: {
        name: 'start server',
        description: 'Starts the Aternos server.',
        async execute(msg, args) {
            if (Konsole.currentStatus == 'offline') {
                msg.channel.send('Starting the server...');

                function onDetectOnline(newStatus) {
                    if (newStatus == AternosStatus.ONLINE) {
                        msg.channel.send('Server is online!');
                        Konsole.off('onStatusUpdate', onDetectOnline);
                    }
                }

                Konsole.on('onStatusUpdate', onDetectOnline);

                await Konsole.startServer();
            } else
                msg.channel.send(`Server is not offline! It is ${Konsole.currentStatus}`);
        },
    }
};

// Add commands to bot
bot.commands = new Discord.Collection();
Object.keys(BOT_CMDS).map(key => {
    bot.commands.set(BOT_CMDS[key].name, BOT_CMDS[key]);
});

async function fetchServerStatus(iter, stop) {
    if (isShuttingDown)
        return stop();

    const results = await Konsole.checkStatus();
    if (results == null)
        return;

    const [serverStatus, playersOnline, queueEta, queuePos] = results;
    let outputMsg, discordStatus;

    if (serverStatus == AternosStatus.ONLINE) {
        discordStatus = `Online ${playersOnline}`;
        outputMsg = `The server is already online with ${playersOnline} players!`;
    } else if (serverStatus == AternosStatus.OFFLINE) {
        discordStatus = 'Offline';
        outputMsg = 'The server is currently offline!';
    } else if ([AternosStatus.STARTING, AternosStatus.LOADING, AternosStatus.PREPARING].includes(serverStatus)) {
        discordStatus = 'Starting up...';
        outputMsg = 'The server is starting up!';
    } else if (serverStatus == AternosStatus.IN_QUEUE) {
        discordStatus = `In queue: ${queuePos}`;
        outputMsg = `The server is in queue for starting up. ETA is ${queueEta} and we're in position ${queuePos}`;
        await Konsole.clickConfirmNowIfNeeded();
    } else if ([AternosStatus.SAVING, AternosStatus.STOPPING].includes(serverStatus)) {
        discordStatus = 'Shutting down...';
        outputMsg = 'The server is shutting down!';
    } else if (serverStatus == AternosStatus.CRASHED) {
        discordStatus = 'Crashed!';
        outputMsg = 'The server has crashed!';
    } else {
        discordStatus = serverStatus;
        console.warn(`WARNING: Unknown status: '${serverStatus}'`);
    }

    await bot.user.setPresence({
        status: 'online',
        activity: {
            name: discordStatus,
            type: 'WATCHING',
        }
    });

    console.log('NOTICE:', outputMsg);
}

// Add listener for when bot is fully initialized
bot.once('ready', () => {
    console.info(`Logged in as ${bot.user.tag}!`);
    interval(fetchServerStatus, STATUS_UPDATE_INTERVAL);
});

// Add listener for when bot is shutting down
diehard.register(async done => {
    isShuttingDown = true;
    await bot.user.setPresence({ status: 'invisible' });
    await Konsole.cleanup();
    done();
});

// Add listener for bot to respond to messages
bot.on('message', msg => {
    const summoned = msg.mentions.users.has(bot.user.id)

    if (summoned) {
        const args = msg.content.split(/ +/);

        // Remove the 'mention' argument
        const user = args.shift();

        let command;
        if (args.length > 0)
            command = args.join(' ');
        else
            command = null;

        console.info(`User '${user}' called command '${command}'`);

        if (!bot.commands.has(command)) return;

        bot.commands.get(command)
            .execute(msg, args)
            .catch(error => {
                console.error(error);
                msg.channel.send('There was an error trying to execute that command!');
            });
    }
});

// main code
(async function() {
    try {
        // Log the bot into Discord
        await bot.login(config.discord.CHAT_TOKEN);

        await bot.user.setPresence({
            status: 'idle',
            activity: {
                name: 'Initializing...',
                type: 'WATCHING',
            }
        });

        // Initialize the Aternos console access
        await Konsole.initialize();

        // Listen for Ctrl+C or uncaught exceptions to clean up bot
        diehard.listen();
    } catch (err) {
        if (err instanceof AternosException) {
            console.error(`ERROR: ${err}`);
            process.exit(-1);
        }
    }
})();
