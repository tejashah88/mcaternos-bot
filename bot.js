// Source: https://www.sitepoint.com/discord-bot-node-js/

'use strict'

// Used to make DateTime generation timezone-consistent
process.env.TZ = 'America/Los_Angeles';

require('make-promises-safe');

require('console-stamp')(console, { 
    format: ':date(mm/dd/yyyy HH:MM:ss.l).cyan' 
});

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

const { AternosManager, AternosException, AternosStatus, ManagerStatus, ServerActions } = require('./aternos-manager');

// Totally not a KDE reference :P
const Konsole = new AternosManager({
    server: config.aternos.SERVER_URL,
    username: config.aternos.ATERNOS_USER,
    password: config.aternos.ATERNOS_PASS
})

async function onMaintenanceStatusUpdate(isMaintenanceEnabled) {
    if (isMaintenanceEnabled) {
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
            if (!Konsole.isInMaintenance())
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
        acceptsArgs: false,
        async execute(msg) {
            const isAdminUser = config.discord.ADMINS.includes(msg.author.tag);

            if (Konsole.hasCrashed() && !isAdminUser) {
                await msg.channel.send('The server has crashed! Please wait while a server admin resolves the issue.')
            } else if ([AternosStatus.OFFLINE, AternosStatus.CRASHED].includes(Konsole.getStatus('serverStatus'))) {
                async function onDetectOnlineOrCrashed(newStatus) {
                    if (newStatus == AternosStatus.ONLINE || newStatus == AternosStatus.CRASHED) {
                        if (newStatus == AternosStatus.ONLINE)
                            await msg.channel.send('Server is online!');
                        else
                            await msg.channel.send('**WARNING**: Server has crashed! You must wait for the admins to restart the server.');

                        Konsole.removeHook('serverStatus', onDetectOnlineOrCrashed);
                        Konsole.removeHook('serverStatus', onFailToEscapeQueue);
                    }
                }

                async function onFailToEscapeQueue(newStatus, oldStatus) {
                    if (newStatus == AternosStatus.OFFLINE && oldStatus == AternosStatus.IN_QUEUE) {
                        await msg.channel.send('Something went wrong when trying to escape the queue. Maybe an AD is in the way?');
                        await Konsole.console.screenshot({ path: `fail-queue-${+new Date()}.png`});
                        Konsole.removeHook('serverStatus', onDetectOnlineOrCrashed);
                        Konsole.removeHook('serverStatus', onFailToEscapeQueue);
                    }
                }

                await Konsole.startServer();
                await msg.channel.send('Starting the server...');

                Konsole.addHook('serverStatus', onDetectOnlineOrCrashed);
                Konsole.addHook('serverStatus', onFailToEscapeQueue);
            } else {
                await msg.channel.send(`Server is not offline! It is ${Konsole.getStatus('serverStatus')}.`);
            }
        }
    },
    StopServer: {
        name: 'stop server',
        description: 'Stops the Aternos server.',
        adminOnly: true,
        acceptsArgs: false,
        async execute(msg) {
            if (Konsole.getStatus('serverStatus') == AternosStatus.ONLINE) {
                async function onDetectOfflineOrCrashed(newStatus) {
                    if (newStatus == AternosStatus.OFFLINE || newStatus == AternosStatus.CRASHED) {
                        if (newStatus == AternosStatus.OFFLINE)
                            await msg.channel.send('Server is offline!');
                        else
                            await msg.channel.send('**WARNING**: Server has crashed! You must wait for the admins to restart the server.');
                        
                        Konsole.removeHook('serverStatus', onDetectOfflineOrCrashed);
                    }
                }

                await Konsole.stopServer();
                await msg.channel.send('Stopping the server...');

                Konsole.addHook('serverStatus', onDetectOfflineOrCrashed);
            } else {
                await msg.channel.send(`Server is not online! It is ${Konsole.getStatus('serverStatus')}.`);
            }
        }
    },
    RestartServer: {
        name: 'restart server',
        description: 'Restarts the Aternos server.',
        adminOnly: true,
        acceptsArgs: false,
        async execute(msg) {
            if (Konsole.getStatus('serverStatus') == AternosStatus.ONLINE) {
                async function onDetectOnlineOrCrashed(newStatus) {
                    if (newStatus == AternosStatus.ONLINE) {
                        await msg.channel.send('Server is online!');
                        Konsole.removeHook('serverStatus', onDetectOnlineOrCrashed);
                    } else if (newStatus == AternosStatus.CRASHED) {
                        await msg.channel.send('**WARNING**: Server has crashed! You must wait for the admins to restart the server.');
                        Konsole.removeHook('serverStatus', onDetectOnlineOrCrashed);
                    }
                }

                await Konsole.restartServer();
                await msg.channel.send('Restarting the server...');

                Konsole.addHook('serverStatus', onDetectOnlineOrCrashed);
            } else {
                await msg.channel.send(`Server is not online! It is ${Konsole.getStatus('serverStatus')}.`);
            }
        }
    },
    MaintenanceOn: {
        name: 'maintenance on',
        description: 'Enables maintenance mode. Only the owner is able to send commands to the bot if maintenance is enabled.',
        adminOnly: true,
        acceptsArgs: false,
        async execute(msg) {
            await Konsole.toggleMaintenance(true);
            await msg.channel.send('Bot will not listen to anyone except for admins!');
        }
    },
    MaintenanceOff: {
        name: 'maintenance off',
        description: 'Disables maintenance mode. Everyone with access to the bot can send commands if maintenance is disabled.',
        adminOnly: true,
        acceptsArgs: false,
        async execute(msg) {
            await Konsole.toggleMaintenance(false);
            await msg.channel.send('Bot is now all ears to everyone!');
        }
    },
    GetUsageStatistics: {
        name: 'usage stats',
        description: "Fetches the bot's and the browsers usage stats.",
        adminOnly: true,
        acceptsArgs: false,
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
    },
    ListBackups: {
        name: 'list backups',
        description: 'Lists all the backups created for the Aternos server.',
        adminOnly: true,
        acceptsArgs: false,
        async execute(msg) {
            const { quotaUsage, backupFiles } = await Konsole.listBackups();

            await msg.channel.send([
                `Number of backups: ${backupFiles.length}`,
                `Disk Usage: ${quotaUsage}`,
            ].join('\n'));

            await msg.channel.send(
                backupFiles.map((file, i) => `${i + 1}) **${file.name}** - *${file.datetime}*`).join('\n')
            );
        }
    },
    CreateBackup: {
        name: 'create backup',
        description: 'Creates a backup for the Aternos server with an optional name.',
        adminOnly: true,
        acceptsArgs: true,
        async execute(msg, args) {
            const backupName = args[0];
            await Konsole.createBackup(backupName, {
                onRequestStart: async () => await msg.channel.send(`Requested to create backup of the universe with the name of '${backupName}'!`),
                onStart: async () => await msg.channel.send(`Creating backup of the universe as we speak...`),
                onFinish: async () => {
                    await msg.channel.send('The backup has finished!');
                    
                    const { quotaUsage, backupFiles } = await Konsole.listBackups();
                    const recentBackupFile = backupFiles[0];
                    await msg.channel.send(`Backup info: **${recentBackupFile.name}** - *${recentBackupFile.datetime}*`);
                },
                onFail: async errMsg => await msg.channel.send(`**Warning**: ${errMsg}`),
            });
        }
    },
    DeleteBackup: {
        name: 'delete backup',
        description: 'Deletes a backup at the given position on the list of backups.',
        adminOnly: true,
        acceptsArgs: true,
        async execute(msg, args) {
            const backupName = args[0];
            await Konsole.deleteBackup(backupName, {
                onStart: async () => await msg.channel.send(`Deleting backup of the universe under the name of '${backupName}' as we speak...`),
                onFinish: async () => {
                    await msg.channel.send('The backup deletion has finished!');
                    await BOT_CMDS.ListBackups.execute(msg);
                },
                onFail: async errMsg => await msg.channel.send(`**Warning**: ${errMsg}`),
            });
        }
    },
    PruneOldBackups: {
        name: 'prune backups',
        description: 'Deletes any old backups that contribute to exceeding backup limit.',
        adminOnly: true,
        acceptsArgs: false,
        async execute(msg, args) {
            let numBackups = (await Konsole.listBackups()).backupFiles.length;
            const BACKUP_FILES_LIMIT = parseInt(config.aternos.BACKUP_LIMIT);

            if (numBackups <= BACKUP_FILES_LIMIT) {
                await msg.channel.send('There are no old backups to delete!');
            } else {
                const numBackupsToDelete = numBackups - BACKUP_FILES_LIMIT;
                await msg.channel.send(`There are ${numBackupsToDelete} old backup(s) to delete! This may take a while...`);

                while (numBackups > BACKUP_FILES_LIMIT) {
                    await Konsole.deleteOldestBackup();
                    numBackups = (await Konsole.listBackups()).backupFiles.length;
                }

                await msg.channel.send(`Finished deleting ${numBackupsToDelete} old backup(s).`);
                await BOT_CMDS.ListBackups.execute(msg);
            }
        }
    }
};

class BotCommander {
    constructor() {
        this.commands = {};
    }

    addCommand(cmd) {
        if (!this.commands.hasOwnProperty(cmd.name))
            this.commands[cmd.name] = cmd;
        else
            throw Exception(`Bot already has command '${cmd.name}' registered!`);
    }

    addCommands(cmds) {
        for (let cmd of cmds)
            this.addCommand(cmd);
    }

    async parseAndExecute(msg) {
        const cmdString = msg.content.trim().split(/ +/).slice(1).join(' ');
        const user = msg.author.tag;
        const isAdminUser = config.discord.ADMINS.includes(user);

        let foundMatch = false;

        for (let command of Object.keys(this.commands)) {
            const cmd = this.commands[command];

            const validNoArgs = !cmd.acceptsArgs && cmdString == command;
            const validWithArgs = !!cmd.acceptsArgs && cmdString.startsWith(command + ' ');

            if (validNoArgs || validWithArgs) {
                foundMatch = true;
                // We have a match, but let's make sure the user can actually execute it first

                // Only admins should be able to run admin-only commands (duh!)
                if (cmd.adminOnly && !isAdminUser) {
                    await msg.channel.send('This command is for admins only!');
                    return;
                }

                // Can't let anyone run bot commands when in maintenance mode
                if (Konsole.isInMaintenance() && !isAdminUser) {
                    await msg.channel.send('**ALERT**: Bot is in maintenance mode and will ignore you unless told otherwise by the server admins!');
                    return;
                }

                if (!isAdminUser) {
                    const isRightChannelType = msg.channel instanceof Discord.TextChannel;

                    const targetServer = bot.guilds.resolve(config.discord.SERVER_ID);
                    const targetChannel = targetServer.channels.resolve(config.discord.CHANNEL_ID);

                    if (!isRightChannelType) {
                        await msg.channel.send(`You can only talk to me in the **#${targetChannel.name}** channel in the *${targetServer.name}* server!`);
                        return;
                    }

                    const isRightTargetServer = msg.guild.id == config.discord.SERVER_ID;
                    const isRightTargetChannel = msg.channel.id == config.discord.CHANNEL_ID;

                    if (!isRightTargetServer) {
                        await msg.channel.send(`You can only talk to me in the **#${targetChannel.name}** channel in the *${targetServer.name}* server!`);
                        return;
                    }

                    if (!isRightTargetChannel) {
                        await msg.channel.send(`You can only talk to me in the **#${targetChannel.name}** channel in this server!`);
                        return;
                    }
                }

                const command = cmd.name;
                let args;

                if (validNoArgs)
                    args = [];
                else {
                    // Parse any arguments and clean them
                    args = cmdString.substring((command + ' ').length).split('"').filter(e => !!e);
                }

                async function executeCommand() {
                    try {
                        await cmd.execute(msg, args);
                    } catch (err) {
                        console.error(err);
                        await msg.channel.send('There was an error trying to execute that command!');
                    }
                }

                // Edge case: When Aternos Manager isn't quite ready, let's add a hook to make sure it'll execute the given command once it is
                async function executeCommandWhenReady(newStatus) {
                    if (Konsole.isReady()) {
                        // No need for retriggers
                        Konsole.removeHook('managerStatus', executeCommandWhenReady);

                        await executeCommand();
                    }
                }

                if (!Konsole.isReady())
                    Konsole.addHook('managerStatus', executeCommandWhenReady);
                else
                    await executeCommand();
            }
        }

        // Let user know if they typed an unknown command
        if (!foundMatch)
            await msg.channel.send('I do not understand that command. Try `start server` if you want to start up the server');
    }
}

// Add commands to bot
const cmder = new BotCommander();
cmder.addCommands(Object.values(BOT_CMDS));

async function updateBotStatus(newFullStatus) {
    if (!Konsole.isReady() || Konsole.isInMaintenance())
        return;

    const { serverStatus, playersOnline, queueEta, queuePos } = newFullStatus;
    let outputMsg, discordStatus;

    switch (serverStatus) {
        case AternosStatus.ONLINE: {
            const reservedSpots = parseInt(playersOnline.split('/')[0]);
            if (reservedSpots === 0) {
                discordStatus = `Online: ${playersOnline} - ${queueEta}`;
                outputMsg = `The server is online with ${playersOnline} players and ${queueEta} left!`;
            } else {
                discordStatus = `Online: ${playersOnline}`;
                outputMsg = `The server is online with ${playersOnline} players!`;
            }

            break;
        }

        case AternosStatus.OFFLINE: {
            discordStatus = 'Offline';
            outputMsg = 'The server is offline!';
            break;
        }

        case AternosStatus.PREPARING:
        case AternosStatus.LOADING: {
            discordStatus = 'Preparing...';
            outputMsg = 'The server is preparing...';
            break;
        }

        case AternosStatus.STARTING: {
            discordStatus = 'Starting up...';
            outputMsg = 'The server is starting up...';
            break;
        }

        case AternosStatus.RESTARTING: {
            discordStatus = 'Restarting...';
            outputMsg = 'The server is restarting...';
            break;
        }

        case AternosStatus.IN_QUEUE: {
            discordStatus = `In queue: ${queuePos}`;
            outputMsg = `The server is in queue. ETA is ${queueEta.substring(4)} and we're in position ${queuePos}`;
            await Konsole.clickConfirmNowIfNeeded();
            break;
        }

        case AternosStatus.STOPPING: {
            discordStatus = 'Shutting down...';
            outputMsg = 'The server is shutting down...';
            break;
        }

        case AternosStatus.SAVING: {
            discordStatus = 'Saving...';
            outputMsg = 'The server is saving data...';
            break;
        }

        case AternosStatus.CRASHED: {
            discordStatus = 'Crashed!';
            outputMsg = 'The server has crashed! The admin must resolve this in order for the bot to receive commands.';
            break;
        }

        default: {
            discordStatus = serverStatus;
            console.warn(`WARNING: Unknown status: '${serverStatus}'`);
        }
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

async function handleBackupGeneration(newStatus, oldStatus, forceUpdate) {
    if (newStatus == AternosStatus.OFFLINE && oldStatus != null && !forceUpdate) {
        console.log('Konsole: Creating backup now that server is offline...');

        const dateOfBackup = new Date().toLocaleString().split(',')[0]; // Just the date in MM/DD/YYYY
        const dateHash = parseInt(+new Date / 1000).toString(16);       // A base-16 time-based hash based on number of seconds since start of epoch
        await Konsole.createBackup(`Automatic backup @ ${dateOfBackup} - ${dateHash}`);
        
        let numBackups = (await Konsole.listBackups()).backupFiles.length;
        const BACKUP_FILES_LIMIT = parseInt(config.aternos.BACKUP_LIMIT);

        console.log('Konsole: Deleting oldest backup(s) to maintain backup limit...');
        while (numBackups > BACKUP_FILES_LIMIT) {
            await Konsole.deleteOldestBackup();
            numBackups = (await Konsole.listBackups()).backupFiles.length;
        }
    }
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

        let userType, fromWhere;
        if (isAdminUser)
            userType = 'Admin';
        else
            userType = 'User';

        if (msg.channel instanceof Discord.TextChannel)
            fromWhere = `'${msg.channel.name}' channel under '${msg.channel.guild.name}' server`;
        else if (msg.channel instanceof Discord.DMChannel)
            fromWhere = `direct message channel`;
        else
            fromWhere = `unknown location in Discord space. (${typeof msg.channel})`

        console.info(`${userType} '${msg.author.tag}' attempted to send command '${command}' from ${fromWhere}`);
        await cmder.parseAndExecute(msg);
    }
});

// main code
(async function() {
    try {
        // Log the bot into Discord
        await bot.login(config.discord.CHAT_TOKEN);

        // Attach listener for full server status
        Konsole.addHook('fullServerStatus', updateBotStatus);

        // Attach listener for triggering backups when server becomes offline
        Konsole.addHook('serverStatus', handleBackupGeneration);

        // Attach listener for maintenance status update
        Konsole.addHook('maintenanceStatus', onMaintenanceStatusUpdate)

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
