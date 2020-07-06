// Source: https://www.sitepoint.com/discord-bot-node-js/

'use strict'

require('make-promises-safe');

// Initialize libraries and variables
const CONFIG_FILE = './config.ini';

const fs = require('fs');
const ini = require('ini');
const config = ini.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));

const Discord = require('discord.js');
const bot = new Discord.Client();

const nodeCleanup = require('node-cleanup');

const pidusage = require('pidusage');
const prettyMS = require('pretty-ms');
const roundTo = require('round-to');
const prettyBytes = require('pretty-bytes');

const { AternosManager, AternosStatus, AternosException, ManagerStatus } = require('./aternos-manager');

// Totally not a KDE reference :P
const Konsole = new AternosManager({
    server: config.aternos.SERVER_URL,
    username: config.aternos.ATERNOS_USER,
    password: config.aternos.ATERNOS_PASS
})

async function onMaintainanceStatusUpdate(isMaintainanceEnabled) {
    if (isMaintainanceEnabled) {
        await bot.user.setPresence({
            status: 'dnd',
            activity: {
                name: 'nobody!',
                type: 'LISTENING',
            }
        });
    } else
        await Konsole.checkStatus(true);
}

async function onConsoleStatusUpdate(currStatus) {
    switch (currStatus) {
        case ManagerStatus.INITIALIZING:
            await bot.user.setPresence({
                status: 'idle',
                activity: {
                    name: 'Initializing...',
                    type: 'WATCHING',
                }
            });
        break;

        case ManagerStatus.READY:
            await Konsole.checkStatus(true);
        break;

        case ManagerStatus.RESTARTING:
            await bot.user.setPresence({
                status: 'idle',
                activity: {
                    name: 'Restarting...',
                    type: 'WATCHING',
                }
            });
        break;

        case ManagerStatus.STOPPING:
            if (!Konsole.isInMaintainance())
                bot.user.setPresence({ status: 'invisible' });
        break;
    }
}

// Command definitions
const BOT_CMDS = {
    StartServer: {
        name: 'start server',
        description: 'Starts the Aternos server.',
        adminOnly: false,
        async execute(msg) {
            const isAdminUser = config.discord.ADMINS.includes(msg.author.tag);

            if (Konsole.hasCrashed() && !isAdminUser) {
                await msg.channel.send('The server has crashed! Please wait while a server admin resolves the issue.')
            } else if ([AternosStatus.OFFLINE, AternosStatus.CRASHED].includes(Konsole.getStatus('serverStatus'))) {
                await msg.channel.send('Starting the server...');

                async function onDetectOnline(newStatus) {
                    if (newStatus == AternosStatus.ONLINE) {
                        await msg.channel.send('Server is online!');
                        Konsole.removeHook('serverStatus', onDetectOnline);
                        Konsole.removeHook('serverStatus', onFailToEscapeQueue);
                    }
                }

                async function onFailToEscapeQueue(newStatus, oldStatus) {
                    if (newStatus == AternosStatus.OFFLINE && oldStatus == AternosStatus.IN_QUEUE) {
                        await msg.channel.send('Something went wrong when trying to escape the queue. Maybe an AD is in the way?');
                        await Konsole.console.screenshot({ path: `fail-queue-${+new Date()}.png`});
                        Konsole.removeHook('serverStatus', onDetectOnline);
                        Konsole.removeHook('serverStatus', onFailToEscapeQueue);
                    }
                }

                Konsole.addHook('serverStatus', onDetectOnline);
                Konsole.addHook('serverStatus', onFailToEscapeQueue);

                await Konsole.requestStartServer();
            } else {
                await msg.channel.send(`Server is not offline! It is ${Konsole.getStatus('serverStatus')}`);
            }
        }
    },
    MaintainanceOn: {
        name: 'maintainance on',
        description: 'Enables maintainance mode. Only the owner is able to send commands to the bot if maintainance is enabled.',
        adminOnly: true,
        async execute(msg) {
            await Konsole.toggleMaintainance(true);
            await msg.channel.send('Bot will not listen to anyone except for admins!');
        }
    },
    MaintainanceOff: {
        name: 'maintainance off',
        description: 'Disables maintainance mode. Everyone with access to the bot can send commands if maintainance is disabled.',
        adminOnly: true,
        async execute(msg) {
            await Konsole.toggleMaintainance(false);
            await msg.channel.send('Bot is now all ears to everyone!');
        }
    },
    GetUsageStatistics: {
        name: 'usage stats',
        description: "Fetches the bot's and the browsers usage stats.",
        adminOnly: true,
        async execute(msg) {
            const processPID = process.pid;
            const browserPID = Konsole.browserPID();

            const processUsage = await pidusage(processPID);
            const browserUsage = await pidusage(browserPID);

            await msg.channel.send([
                'Process Usage:',
                `- **CPU**: ${roundTo(processUsage.cpu, 1)} %`,
                `- **RAM**: ${prettyBytes(processUsage.memory)}`,
                `- **Uptime**: ${prettyMS(processUsage.elapsed)}`,
            ].join('\n'));

            await msg.channel.send([
                'Browser Usage:',
                `- **CPU**: ${roundTo(browserUsage.cpu, 1)} %`,
                `- **RAM**: ${prettyBytes(browserUsage.memory)}`,
                `- **Uptime**: ${prettyMS(browserUsage.elapsed)}`,
            ].join('\n'));
        }
    }
};

// Add commands to bot
bot.commands = new Discord.Collection();
Object.keys(BOT_CMDS).map(key => {
    bot.commands.set(BOT_CMDS[key].name, BOT_CMDS[key]);
});

async function updateBotStatus(newFullStatus) {
    if (!Konsole.isReady() || Konsole.isInMaintainance())
        return;

    const { serverStatus, playersOnline, queueEta, queuePos } = newFullStatus;
    let outputMsg, discordStatus;

    if (serverStatus == AternosStatus.ONLINE) {
        const reservedSpots = parseInt(playersOnline.split('/')[0]);
        if (reservedSpots === 0) {
            discordStatus = `Online: ${playersOnline} - ${queueEta}`;
            outputMsg = `The server is online with ${playersOnline} players and ${queueEta} left!`;
        } else {
            discordStatus = `Online: ${playersOnline}`;
            outputMsg = `The server is online with ${playersOnline} players!`;
        }
    } else if (serverStatus == AternosStatus.OFFLINE) {
        discordStatus = 'Offline';
        outputMsg = 'The server is offline!';
    } else if ([AternosStatus.STARTING, AternosStatus.PREPARING, AternosStatus.LOADING].includes(serverStatus)) {
        discordStatus = 'Starting up...';
        outputMsg = 'The server is starting up...';
    } else if (serverStatus == AternosStatus.IN_QUEUE) {
        discordStatus = `In queue: ${queuePos}`;
        outputMsg = `The server is in queue. ETA is ${queueEta.substring(4)} and we're in position ${queuePos}`;
        await Konsole.clickConfirmNowIfNeeded();
    } else if ([AternosStatus.SAVING, AternosStatus.STOPPING].includes(serverStatus)) {
        discordStatus = 'Shutting down...';
        outputMsg = 'The server is shutting down...';
    } else if (serverStatus == AternosStatus.CRASHED) {
        discordStatus = 'Crashed!';
        outputMsg = 'The server has crashed! The admin must resolve this in order for the bot to receive commands.';
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
});

async function botCleanup() {
    await Konsole.cleanup();
}

nodeCleanup(function (exitCode, signal) {
    botCleanup().then(() => {
        if (!signal)
            signal = 'SIGINT';
        process.kill(process.pid, signal);
    });

    nodeCleanup.uninstall();
    return false;
});

// Add listener for bot to respond to messages
bot.on('message', async msg => {
    const summoned = msg.mentions.users.has(bot.user.id);

    // Check only if the bot has been explicitly summoned
    if (summoned) {
        // Make sure to remove the 'mention' argument
        const command = msg.content.trim().split(/ +/).slice(1).join(' ');
        const isAdminUser = config.discord.ADMINS.includes(msg.author.tag);

        if (command.length <= 0)
            return;

        console.info(`${isAdminUser ? 'Admin' : 'User'} '${msg.author.tag}' attempted to send command '${command}'`);

        // Let user know if they typed an unknown command
        if (!bot.commands.has(command)) {
            await msg.channel.send('I do not understand that command. Try `start server` if you want to start up the server');
            return;
        }

        const cmd = bot.commands.get(command);

        // Only admins should be able to run admin-only commands (duh!)
        if (cmd.adminOnly && !isAdminUser) {
            await msg.channel.send('This command is for admins only!');
            return;
        }

        // Can't let anyone run bot commands when in maintainance mode
        if (Konsole.isInMaintainance() && !isAdminUser) {
            await msg.channel.send('**ALERT**: Bot is in maintainance mode and will ignore you unless told otherwise by the server admins!');
            return;
        }

        cmd.execute(msg)
            .catch(error => {
                console.error(error);
                return msg.channel.send('There was an error trying to execute that command!');
            });
    }
});

// main code
(async function() {
    try {
        // Log the bot into Discord
        await bot.login(config.discord.CHAT_TOKEN);

        // Attach listener for full server status
        Konsole.addHook('fullServerStatus', updateBotStatus);

        // Attach listener for maintainance status update
        Konsole.addHook('maintainanceStatus', onMaintainanceStatusUpdate)

        // Attach listener for manager status update
        Konsole.addHook('managerStatus', onConsoleStatusUpdate);

        // Initialize the Aternos console access
        await Konsole.initialize();

        // Notify PM2 that we are ready
        if (process.send !== undefined)
            process.send('ready');
    } catch (err) {
        if (err instanceof AternosException) {
            console.error(`ERROR: ${err}`);
            // We send a SIGINT to ourselves to make sure the bot cleans itself up
            process.kill(process.pid, 'SIGINT');
        } else
            throw err;
    }
})();
