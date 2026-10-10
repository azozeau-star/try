const fs = require('node:fs');
const path = require('node:path');
const configured = (process.env.SAMI_BACKEND_URL || '').trim().replace(/\/+$/, '');
if (process.env.NETLIFY && !configured) {
    throw new Error('Set SAMI_BACKEND_URL to your deployed Node.js backend URL in Netlify environment variables, then redeploy.');
}
if (configured) {
    const url = new URL(configured);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) {
        throw new Error('SAMI_BACKEND_URL must be an origin such as https://your-service.onrender.com (no path or secrets).');
    }
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
        throw new Error('A public backend must use HTTPS.');
    }
}
fs.writeFileSync(path.join(__dirname, '../docs/config.js'),
    '// Public backend URL only; never put keys or passwords here.\n' +
    'window.SAMI_BACKEND_URL = ' + JSON.stringify(configured) + ';\n');
console.log(configured ? 'Static site configured for the external backend.' : 'Static site configured for the same Node.js server.');
