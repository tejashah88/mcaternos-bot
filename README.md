# mcaternos-bot
A bot that let's your friends start your Aternos server without leaving Discord.

## Setup
1. Clone this repo into the machine where you'll be hosting the bot.
2. Run `npm install`
3. Copy the config from below into a new file called `config.ini` and change the variables to your suiting. Note that you'll need an Aternos account with friend access to your server.

```
[discord]
CHAT_TOKEN = INSERT_VALID_TOKEN_HERE

[aternos]
SERVER_URL = example.aternos.me
ATERNOS_USER = example_user_123
ATERNOS_PASS = example_pass_456
```

4. Run `npm start` to start the bot.

## Commands
* `start server` - Starts the Aternos server up