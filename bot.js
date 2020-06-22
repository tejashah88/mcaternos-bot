// Source: https://www.sitepoint.com/discord-bot-node-js/

'use strict'

require('make-promises-safe');

// Initialize libraries and variables
const CONFIG_FILE = './config.ini';

const fs = require('fs');
const ini = require('ini');
const config = ini.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));

const diehard = require('diehard');

const Discord = require('discord.js');
const bot = new Discord.Client();

const { AternosManager, AternosStatus, AternosException } = require('./aternos-manager');

// Totally not a KDE reference :P
const Konsole = new AternosManager(config.aternos.SERVER_URL)
Konsole.setLoginDetails(config.aternos.ATERNOS_USER, config.aternos.ATERNOS_PASS);

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

// Command definitions
const BOT_CMDS = {
    StartServer: {
        name: 'start server',
        description: 'Starts the Aternos server.',
        adminOnly: false,
        async execute(msg) {
            switch (Konsole.currentStatus.serverStatus) {
                case AternosStatus.OFFLINE:
                    await msg.channel.send('Starting the server...');

                    async function onDetectOnline(newStatus) {
                        if (newStatus == AternosStatus.ONLINE) {
                            await msg.channel.send('Server is online!');
                            Konsole.off('statusUpdate', onDetectOnline);
                        }
                    }

                    Konsole.on('statusUpdate', onDetectOnline);

                    await Konsole.startServer();
                    break;

                case AternosStatus.CRASHED:
                    await msg.channel.send('The server has crashed! Please wait while a server admin resolves the issue.')
                    break;

                default:
                    await msg.channel.send(`Server is not offline! It is ${Konsole.currentStatus.serverStatus}`);
            }
        }
    },
    MaintainanceOn: {
        name: 'maintainance on',
        description: 'Enables maintainance mode. Only the owner is able to send commands to the bot if enabled.',
        adminOnly: true,
        async execute(msg) {
            await Konsole.toggleMaintainance(true);
        }
    },
    MaintainanceOff: {
        name: 'maintainance off',
        description: 'Disables maintainance mode. Everyone with access to the bot can send commands if enabled.',
        adminOnly: true,
        async execute(msg) {
            await Konsole.toggleMaintainance(false);
        }
    }
};

// Add commands to bot
bot.commands = new Discord.Collection();
Object.keys(BOT_CMDS).map(key => {
    bot.commands.set(BOT_CMDS[key].name, BOT_CMDS[key]);
});

async function updateBotStatus(newFullStatus) {
    if (Konsole.isInMaintainance())
        return;

    const { serverStatus, playersOnline, queueEta, queuePos } = newFullStatus;
    let outputMsg, discordStatus;

    if (serverStatus == AternosStatus.ONLINE) {
        discordStatus = `Online ${playersOnline}`;
        outputMsg = `The server is online with ${playersOnline} players!`;
    } else if (serverStatus == AternosStatus.OFFLINE) {
        discordStatus = 'Offline';
        outputMsg = 'The server is offline!';
    } else if ([AternosStatus.STARTING, AternosStatus.LOADING].includes(serverStatus)) {
        discordStatus = 'Starting up...';
        outputMsg = 'The server is starting up...';
    } else if ([AternosStatus.IN_QUEUE, AternosStatus.PREPARING].includes(serverStatus)) {
        discordStatus = `In queue: ${queuePos}`;
        outputMsg = `The server is in queue. ETA is ${queueEta} and we're in position ${queuePos}`;
        if (serverStatus == AternosStatus.IN_QUEUE)
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

// Add listener for when bot is shutting down
diehard.register(async done => {
    await bot.user.setPresence({ status: 'invisible' });
    await Konsole.cleanup();
    done();
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

        await bot.user.setPresence({
            status: 'idle',
            activity: {
                name: 'Initializing...',
                type: 'WATCHING',
            }
        });

        // Attach listener for full server status
        Konsole.on('fullStatusUpdate', updateBotStatus);

        // Attach listener for maintainance status update
        Konsole.on('maintainanceUpdate', onMaintainanceStatusUpdate)

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
