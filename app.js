// Entry point for Hostinger / Passenger Node.js environments
const fs = require('fs');

process.on('uncaughtException', (err) => {
    fs.appendFileSync('./hostinger-error.log', new Date().toISOString() + ' Uncaught Exception: ' + (err.stack || err) + '\n');
    console.error(err);
});

process.on('unhandledRejection', (reason, promise) => {
    fs.appendFileSync('./hostinger-error.log', new Date().toISOString() + ' Unhandled Rejection: ' + (reason.stack || reason) + '\n');
    console.error(reason);
});

try {
    fs.appendFileSync('./hostinger-error.log', new Date().toISOString() + ' App starting...\n');
    require('./dist/server.js');
} catch (e) {
    fs.appendFileSync('./hostinger-error.log', new Date().toISOString() + ' Startup Error: ' + (e.stack || e.toString()) + '\n');
    console.error(e);
}
