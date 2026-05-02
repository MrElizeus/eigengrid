import WebSocket from 'ws';
import { Client as SSHClient } from 'ssh2';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BRIDGE_PORT = parseInt(process.env.SSH_BRIDGE_PORT || '4000', 10);
const LARAVEL_API_URL = process.env.LARAVEL_API_URL || 'http://127.0.0.1:8000';
const BRIDGE_SECRET = process.env.SSH_BRIDGE_SECRET;

if (!BRIDGE_SECRET) {
  console.error('ERROR: SSH_BRIDGE_SECRET environment variable is not set');
  process.exit(1);
}

const wss = new WebSocket.Server({ port: BRIDGE_PORT });

console.log(`SSH Bridge listening on port ${BRIDGE_PORT}`);
console.log(`Laravel API: ${LARAVEL_API_URL}`);

wss.on('connection', (ws, req) => {
  console.log(`[WS] New connection from ${req.socket.remoteAddress}`);

  const urlParams = new URL(req.url, 'ws://localhost').searchParams;
  const token = urlParams.get('token');

  if (!token) {
    console.log('[WS] Missing token, closing connection');
    ws.close(4001, 'Missing token');
    return;
  }

  // Validate and retrieve session from Laravel
  validateSession(token)
    .then(session => {
      if (!session) {
        console.log(`[SSH] Invalid or expired token: ${token}`);
        ws.close(4004, 'Invalid or expired session');
        return;
      }

      console.log(`[SSH] Starting SSH tunnel for machine: ${session.machine_id}`);
      startSSHTunnel(ws, session);
    })
    .catch(err => {
      console.error(`[SSH] Error validating session: ${err.message}`);
      ws.close(4500, 'Auth service error');
    });

  ws.on('error', err => {
    console.error(`[WS] Error: ${err.message}`);
  });

  ws.on('close', () => {
    console.log('[WS] Connection closed');
  });
});

/**
 * Validate session token with Laravel API
 */
async function validateSession(token) {
  const tokenRegex = /^[a-zA-Z0-9]{40}$/;
  if (!tokenRegex.test(token)) {
    throw new Error('Invalid token format');
  }

  const response = await fetch(`${LARAVEL_API_URL}/api/ssh/session/${token}`, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'X-Bridge-Secret': BRIDGE_SECRET,
    },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Laravel API error: ${response.status}`);
  }

  return response.json();
}

/**
 * Establish SSH tunnel: jump -> bastion -> target
 */
function startSSHTunnel(ws, session) {
  let jumpConn = null;
  let bastionConn = null;
  let targetShell = null;

  try {
    // Step 1: Connect to jump host (VPS)
    jumpConn = new SSHClient();
    const jumpConfig = {
      host: session.bastion.jump_host,
      port: 22,
      username: session.bastion.jump_user,
      readyTimeout: 10000,
      algorithms: {
        serverHostKey: ['ssh-rsa', 'ssh-dss', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521'],
      },
    };

    // Add authentication method to jump host
    if (session.bastion.auth === 'key' && session.bastion.key_path) {
      jumpConfig.privateKey = readSync(session.bastion.key_path);
    } else if (session.bastion.password) {
      jumpConfig.password = session.bastion.password;
    } else {
      throw new Error('No authentication method configured for jump host');
    }

    jumpConn.on('ready', () => {
      console.log('[SSH] Jump host connected, opening forward tunnel...');

      // Step 2: Open forward tunnel from jump host to bastion
      jumpConn.forwardOut(
        '127.0.0.1', 0,
        session.bastion.host,
        session.bastion.port,
        (err, stream) => {
          if (err) {
            console.error(`[SSH] Forward tunnel error: ${err.message}`);
            ws.close(4500, 'Tunnel error');
            jumpConn.end();
            return;
          }

          console.log('[SSH] Forward tunnel opened to bastion, connecting...');

          // Step 3: Connect to bastion through the forwarded stream
          bastionConn = new SSHClient();
          const bastionConfig = {
            sock: stream,
            username: session.bastion.user,
            readyTimeout: 10000,
            algorithms: {
              serverHostKey: ['ssh-rsa', 'ssh-dss', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521'],
            },
          };

          // Add authentication method to bastion
          if (session.bastion.auth === 'key' && session.bastion.key_path) {
            bastionConfig.privateKey = readSync(session.bastion.key_path);
          } else if (session.bastion.password) {
            bastionConfig.password = session.bastion.password;
          } else {
            throw new Error('No authentication method configured for bastion');
          }

          bastionConn.on('ready', () => {
            console.log('[SSH] Connected to bastion, opening second forward tunnel to target...');

            // Step 4: Open another forward tunnel from bastion to target machine
            bastionConn.forwardOut(
              '127.0.0.1', 0,
              session.ssh_host,
              session.ssh_port,
              (err, stream2) => {
                if (err) {
                  console.error(`[SSH] Target forward tunnel error: ${err.message}`);
                  ws.close(4500, 'Target tunnel error');
                  cleanup();
                  return;
                }

                console.log('[SSH] Target tunnel opened, connecting to SSH...');

                // Step 5: Connect to target machine through the second tunnel
                const targetConn = new SSHClient();
                const targetConfig = {
                  sock: stream2,
                  username: session.ssh_user,
                  readyTimeout: 10000,
                  algorithms: {
                    serverHostKey: ['ssh-rsa', 'ssh-dss', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521'],
                  },
                };

                // Add authentication method to target
                if (session.ssh_auth === 'key' && session.ssh_key_path) {
                  targetConfig.privateKey = readSync(session.ssh_key_path);
                } else if (session.ssh_password) {
                  targetConfig.password = session.ssh_password;
                } else {
                  throw new Error('No authentication method configured for target');
                }

                targetConn.on('ready', () => {
                  console.log('[SSH] Connected to target machine, opening shell...');

                  // Step 6: Open interactive shell on target machine
                  targetConn.shell({ term: 'xterm-256color' }, (err, shell) => {
                    if (err) {
                      console.error(`[SSH] Shell error: ${err.message}`);
                      ws.close(4500, 'Shell error');
                      cleanup();
                      return;
                    }

                    targetShell = shell;
                    console.log('[SSH] Interactive shell established');

                    // Send shell data to WebSocket
                    shell.on('data', data => {
                      try {
                        ws.send(data);
                      } catch (err) {
                        console.error(`[WS] Send error: ${err.message}`);
                      }
                    });

                    shell.stderr?.on('data', data => {
                      try {
                        ws.send(data);
                      } catch (err) {
                        console.error(`[WS] Send error: ${err.message}`);
                      }
                    });

                    // Handle WebSocket messages
                    ws.on('message', msg => {
                      try {
                        // Check if it's a resize command (JSON)
                        if (msg instanceof Buffer && msg.toString().startsWith('{')) {
                          const cmd = JSON.parse(msg.toString());
                          if (cmd.type === 'resize' && cmd.cols && cmd.rows) {
                            shell.setWindow(cmd.rows, cmd.cols, 0, 0);
                            console.log(`[SSH] Terminal resized to ${cmd.cols}x${cmd.rows}`);
                            return;
                          }
                        }
                        // Regular input data
                        shell.write(msg);
                      } catch (err) {
                        console.error(`[WS] Message error: ${err.message}`);
                      }
                    });

                    // Handle shell close
                    shell.on('close', () => {
                      console.log('[SSH] Shell closed');
                      try {
                        ws.close(1000, 'Shell closed');
                      } catch (err) {
                        // ws already closed
                      }
                      cleanup();
                    });

                    shell.on('error', err => {
                      console.error(`[SSH] Shell error: ${err.message}`);
                      try {
                        ws.close(4500, 'Shell error');
                      } catch (err) {
                        // ws already closed
                      }
                      cleanup();
                    });
                  });
                });

                targetConn.on('error', err => {
                  console.error(`[SSH] Target connection error: ${err.message}`);
                  ws.close(4500, 'Target connection error');
                  cleanup();
                });

                targetConn.connect(targetConfig);
              }
            );
          });

          bastionConn.on('error', err => {
            console.error(`[SSH] Bastion connection error: ${err.message}`);
            ws.close(4500, 'Bastion connection error');
            cleanup();
          });

          bastionConn.connect(bastionConfig);
        }
      );
    });

    jumpConn.on('error', err => {
      console.error(`[SSH] Jump connection error: ${err.message}`);
      ws.close(4500, 'Jump connection error');
    });

    jumpConn.on('timeout', () => {
      console.error('[SSH] Jump connection timeout');
      ws.close(4500, 'Connection timeout');
    });

    jumpConn.connect(jumpConfig);
  } catch (err) {
    console.error(`[SSH] Setup error: ${err.message}`);
    ws.close(4500, 'Setup error');
  }

  // Handle WebSocket close
  const originalClose = ws.close;
  ws.close = function(...args) {
    cleanup();
    return originalClose.apply(this, args);
  };

  function cleanup() {
    console.log('[SSH] Cleaning up connections');
    if (targetShell) {
      try {
        targetShell.end();
      } catch (err) {
        // Ignore
      }
    }
    if (bastionConn) {
      bastionConn.end();
    }
    if (jumpConn) {
      jumpConn.end();
    }
  }

  // Send initial prompt/greeting
  setTimeout(() => {
    try {
      ws.send(Buffer.from('Connected to EigenGrid SSH Terminal\n'));
    } catch (err) {
      // Ignore
    }
  }, 500);
}

/**
 * Synchronous file read helper
 */
function readSync(filePath) {
  try {
    const absolutePath = resolve(filePath);
    return readFileSync(absolutePath);
  } catch (err) {
    throw new Error(`Cannot read key file: ${filePath}`);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  wss.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  wss.close(() => {
    process.exit(0);
  });
});
