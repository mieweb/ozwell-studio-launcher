/**
 * Socket.io wiring: the app listens for `status` events about the user's
 * own creates ({ hostname, status, url?, message? }); status values are
 * the canonical vocabulary documented in studios/service.js. Auth is the
 * same authenticate() the HTTP preHandler hook uses.
 */
import { Server as SocketIOServer } from 'socket.io';
import { authenticate } from './auth.js';
import studios from './studios/service.js';

export function attachSocket(httpServer) {
  const io = new SocketIOServer(httpServer);

  io.on('connection', (socket) => {
    const { username, denied } = authenticate(socket.conn.remoteAddress, socket.handshake.headers);
    if (denied) {
      // Connection-level rejection: no hostname, just the failure.
      socket.emit('status', { status: 'failed', message: denied.message });
      return socket.disconnect(true);
    }

    const forward = (entry) => {
      if (entry.owner === username) {
        socket.emit('status', {
          hostname: entry.hostname,
          status: entry.status,
          url: entry.url,
          message: entry.message,
        });
      }
    };
    studios.events.on('status', forward);
    socket.on('disconnect', () => studios.events.off('status', forward));
  });

  return io;
}
