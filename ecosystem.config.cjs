require('dotenv').config({ path: '/home/meridian/meridian/.env' });
module.exports = {
  apps: [{
    name: 'meridian',
    script: 'index.js',
    cwd: '/home/meridian/meridian',
    interpreter: 'node',
    env: process.env
  }]
}
