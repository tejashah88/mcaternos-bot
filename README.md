:warning: :warning: New maintainer needed :warning: :warning:

For anyone visiting this project, this bot does not work with the current version of Aternos's website (October 2021) as this bot was created about a year ago. I don't use Aternos and I haven't had the time nor the motivation to maintain this project despite noticing increased interest in the project. If you're interested in becoming an active maintainer, feel free to submit PRs to update the bot.

Thank you

@tejashah88

# mcaternos-bot
A bot that lets your friends start your Aternos server without leaving Discord.

## Setup
1. Clone this repo into the machine where you'll be hosting the bot.
2. Run `npm install`
3. Copy the config from below into a new file called `config.ini` and change the variables to your suiting (note that the admin discord tags are surrounded in quotes). Note that you'll need an Aternos account with friend access to your server.

```
[discord]
ADMINS[] = "exampleAdmin#1234"
ADMINS[] = "anotherAdmin#5678"
CHAT_TOKEN = INSERT_VALID_TOKEN_HERE

[aternos]
SERVER_URL = example.aternos.me
ATERNOS_USER = example_user_123
ATERNOS_PASS = example_pass_456
BACKUP_LIMIT = 10
```

4. Run `npm run start-prod` to start the bot and `npm run stop-prod` to stop the bot.

## Commands
* `start/stop/restart server` - Starts/Stops/Restarts the Aternos server
* `maintenance on/off` - Enables/Disables maintenance mode. Only the admin(s) can send commands to it when enabled.
* `usage stats` - Prints out the bot's process and attached browser's resources usage
* `list backups` - Lists all the backups for the Aternos server
* `create/delete backup "Insert backup name here"` - Creates/Deletes a world backup with name given
