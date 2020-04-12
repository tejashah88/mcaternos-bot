// Source: https://www.sitepoint.com/discord-bot-node-js/

// Initialize libraries and environment variables
require('dotenv').config();
const Discord = require('discord.js');
const bot = new Discord.Client();
const TOKEN = process.env.CHAT_TOKEN;

const STATUS_UPDATE_INTERVAL = 15 * 1000;

const { GlobalAternosManager, AternosException } = require('./aternos-manager');

// Add commands to bot
const botCmds = require('./commands');

bot.commands = new Discord.Collection();
Object.keys(botCmds).map(key => {
    bot.commands.set(botCmds[key].name, botCmds[key]);
});


function monitorServerStatus() {
    GlobalAternosManager.checkStatus()
        .then(([status, playersOnline]) => {
            return bot.user.setPresence({
                status: 'online',
                activity: {
                    name: `MC server: ${status}`,
                    type: 'WATCHING',
                }
            });
        });
}


// Add listener for when bot is fully initialized
bot.once('ready', () => {
    console.info(`Logged in as ${bot.user.tag}!`);

    bot.setInterval(monitorServerStatus, STATUS_UPDATE_INTERVAL);
});

// Add listener for bot to respond to messages
bot.on('message', msg => {
    const summoned = msg.mentions.users.has(bot.user.id)

    if (summoned) {
        const args = msg.content.split(/ +/);

        // Remove the mention 'argument'
        args.shift();

        let command;
        if (args.length > 0)
            command = args.shift().toLowerCase();
        else
            command = null;

        console.info(`Called command: '${command}' with args '${args}'`);

        if (!bot.commands.has(command)) return;

        bot.commands.get(command)
            .execute(msg, args)
            .catch(error => {
                console.error(error);
                msg.channel.send('There was an error trying to execute that command!');
            });
    }
});

// Log the bot into Discord
bot.login(TOKEN);
