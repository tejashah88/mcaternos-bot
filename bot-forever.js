const fs = require('fs');
const forever = require('forever-monitor');
const pidusage = require('pidusage');
const delay = require('delay');
const runInfinitely = require('p-forever');

const MAX_RAM = 2 * 1024 * 1024 * 1024;  // 2 GB
const CHECK_INTERVAL = 5 * 1000;         // 5 seconds
const RESTART_INTERVAL = 3 * 1000;       // 3 seconds

// Create logs folder for forever process
fs.mkdirSync('logs', { recursive: true });

// Make child process for bot
const child = new (forever.Monitor)('bot.js', {
    silent: true,
    killTree: true,
    logFile: 'logs/forever.log', // Path to log output from forever process (when daemonized)
    outFile: 'logs/output.log',  // Path to log output from child stdout
    errFile: 'logs/error.log',   // Path to log output from child stderr
});

// Hook event listeners
child.on('start', function(process, data) {
    console.log('Discord bot process has started!');
});

child.on('exit:code', function(code) {
    console.error('Discord bot exited with code ' + code);
});

child.on('stdout', function (data) {
    console.log('STDOUT:', data.toString('utf-8').trim());
});

child.on('stderr', function (data) {
    console.error('STDERR:', data.toString('utf-8').trim());
});

// Start bot forever process and print PID for debugging
child.start();
console.log('Child PID:', child.child.pid);

runInfinitely(async () => {
    // Get usage stats from PID and check if memory usage exceeds allowed amount of RAM
    const stats = await pidusage(child.child.pid);
    console.log('CPU Usage:', stats.cpu, '% / Memory usage:', stats.memory / (1024 * 1024), 'MB');

    if (stats.memory > MAX_RAM) {
        console.log('Restarting bot to free RAM...');
        child.stop();
        await delay(RESTART_INTERVAL);
        child.start();
    }

    await delay(CHECK_INTERVAL);
});
