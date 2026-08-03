import http from 'http';
import 'dotenv/config';
import App from './app.js';

import config from './configs/variables.config.js';

const { PORT } = config;

const init = async () => {
  const server = http.createServer(App.app);
  App.init(server);

  const _onError = (error) => {
    console.error(error.message);
  };

  const _onListening = () => {
    const address = server.address();
    const bind = typeof address === 'string'
      ? `pipe ${address}`
      : `${address.port}`;

      console.info(`\tPort: ${bind}`);
      console.info(`\tStart date: ${(new Date()).toUTCString()} \n`);
  };

  
  server.listen(PORT);
  server.on('error', _onError);
  server.on('listening', _onListening);
};

export default init().catch(console.error);
