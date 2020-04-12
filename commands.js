require('dotenv').config();
const ATERNOS_USER = process.env.ATERNOS_USER;
const ATERNOS_PASS = process.env.ATERNOS_PASS;

const { GlobalAternosManager, AternosException } = require('./aternos-manager');

const CheckServer = {
    name: 'status',
    description: 'Checks the status of the Aternos server.',
    execute(msg, args) {
        return GlobalAternosManager.checkStatus()
            .then(([status, playersOnline]) => {
                let extraMsg = '';
                if (status == 'online')
                    extraMsg = ` with ${playersOnline} players!`;

                if (status != 'unknown') {
                    msg.channel.send(`The server is **${status.toUpperCase()}**${extraMsg}`);
                } else {
                    msg.channel.send('Oh no! I was unable to check the server status! Maybe aternos.me is down?');
                }
            });
    },
};

const StartServer = {
    name: 'start',
    description: 'Starts the Aternos server.',
    execute(msg, args) {
        return GlobalAternosManager.isLoggedin()
            .then(loggedin => {
                if (!loggedin) {
                    msg.channel.send('Logging into Aternos console...');
                    return GlobalAternosManager.login(ATERNOS_USER, ATERNOS_PASS)
                        .then(() => {
                            msg.channel.send('Starting the server...');
                            return GlobalAternosManager.startServer();
                        })
                        .catch(err => {
                            console.error(err);
                            if (err instanceof AternosException) {
                                msg.channel.send('Oh no! I was unable to log into Aternos!');
                                msg.channel.send(err.message);
                            }
                        })
                } else {
                    msg.channel.send('Starting the server...');
                    return GlobalAternosManager.startServer();
                }
            })
            .then(outputMsg => {
                msg.channel.send(outputMsg);
            })
            .catch(err => {
                console.error(err);
                if (err instanceof AternosException) {
                    msg.channel.send('Oh no! Something went wrong when trying to start the server!');
                    msg.channel.send(err.message);
                }
            });
    },
};

module.exports = { CheckServer, StartServer };
