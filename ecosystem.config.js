module.exports = {
  apps: [{
    name: 'live-voting',
    script: 'server.js',
    cwd: '/var/www/question',
    instances: 1,
    autorestart: true,
    restart_delay: 3000,
    max_restarts: 10,
    env: {
      NODE_ENV: 'production',
      PORT: 8080
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: '/var/log/live-voting/error.log',
    out_file:   '/var/log/live-voting/out.log'
  }]
};
