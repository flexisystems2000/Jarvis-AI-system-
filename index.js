const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    jidNormalizedUser
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

let sock;
let pairingCodeGlobal = '';
let connectionStatus = 'disconnected';

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection) {
            connectionStatus = connection;
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                startBot();
            } else {
                connectionStatus = 'loggedOut';
            }
        } else if (connection === 'open') {
            connectionStatus = 'connected';
            pairingCodeGlobal = '';
            console.log('WhatsApp Bot connected successfully.');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message) return;

        const remoteJid = msg.key.remoteJid;
        const senderJid = jidNormalizedUser(msg.key.participant || msg.key.remoteJid);
        const botOwnerJid = sock.user ? jidNormalizedUser(sock.user.id) : null;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

        if (text.trim() === '.addxxjarvis') {
            // Check 1: Ensure only the connected bot owner can run the command
            if (!botOwnerJid || senderJid !== botOwnerJid) {
                return; // Silently ignore if someone else types it
            }

            // Check 2: Ensure it is a group chat
            if (!remoteJid.endsWith('@g.us')) {
                await sock.sendMessage(remoteJid, { text: 'This command can only be executed inside a WhatsApp group.' }, { quoted: msg });
                return;
            }

            try {
                // Fetch fresh group metadata from WhatsApp servers
                const groupMetadata = await sock.groupMetadata(remoteJid);
                const participants = groupMetadata.participants || [];
                
                const botParticipant = participants.find(p => jidNormalizedUser(p.id) === botOwnerJid);

                // Check 3: Strictly verify admin status using Baileys admin flags ('admin' or 'superadmin')
                const isAdmin = botParticipant && (botParticipant.admin === 'admin' || botParticipant.admin === 'superadmin');

                if (!isAdmin) {
                    await sock.sendMessage(remoteJid, { text: 'Failure: Bot is not an admin in this group. Please promote the bot first.' }, { quoted: msg });
                    return;
                }

                // Official platform JID node update for Meta AI group inclusion
                await sock.groupParticipantsUpdate(remoteJid, ['11111111111@bot'], 'add');

                await sock.sendMessage(remoteJid, { text: 'Meta AI added successfully.' }, { quoted: msg });
            } catch (error) {
                const errorReason = error?.data?.message || error?.message || String(error);
                await sock.sendMessage(remoteJid, { text: `Failure: ${errorReason}` }, { quoted: msg });
            }
        }
    });
}

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <title>WhatsApp Dashboard - Render</title>
            <style>
                body { font-family: Arial, sans-serif; background: #f4f7f6; margin: 0; padding: 50px; display: flex; justify-content: center; }
                .card { background: white; padding: 30px; border-radius: 8px; box-shadow: 0 4px 10px rgba(0,0,0,0.1); width: 400px; text-align: center; }
                h2 { color: #075e54; }
                .status { font-weight: bold; margin: 15px 0; padding: 10px; border-radius: 4px; }
                .connected { background: #d4edda; color: #155724; }
                .disconnected { background: #f8d7da; color: #721c24; }
                input { width: 90%; padding: 10px; margin: 10px 0; border: 1px solid #ccc; border-radius: 4px; }
                button { background: #25d366; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-size: 16px; width: 100%; }
                button:hover { background: #128c7e; }
                .code-box { font-size: 24px; font-weight: bold; letter-spacing: 3px; background: #e9ecef; padding: 15px; margin: 15px 0; border-radius: 4px; color: #333; }
            </style>
        </head>
        <body>
            <div class="card">
                <h2>WhatsApp Meta AI Bot</h2>
                <div class="status ${connectionStatus}">Status: ${connectionStatus.toUpperCase()}</div>
                
                ${connectionStatus === 'connected' ? '<p>Your bot is active and connected!</p>' : `
                    <form action="/pair" method="POST">
                        <p>Enter your phone number with country code (digits only):</p>
                        <input type="text" name="phone" placeholder="e.g., 2348012345678" required />
                        <button type="submit">Generate Pairing Code</button>
                    </form>
                `}

                ${pairingCodeGlobal ? `
                    <h3>Your Pairing Code:</h3>
                    <div class="code-box">${pairingCodeGlobal}</div>
                    <p>Go to WhatsApp > Settings > Linked Devices > Link a Device > Link with phone number and enter this code.</p>
                ` : ''}
            </div>
        </body>
        </html>
    `);
});

app.post('/pair', async (req, res) => {
    const phoneNumber = req.body.phone;
    if (!phoneNumber) {
        return res.redirect('/');
    }

    try {
        const cleanedNumber = phoneNumber.replace(/[^0-9]/g, '');
        if (sock && !sock.authState.creds.registered) {
            pairingCodeGlobal = await sock.requestPairingCode(cleanedNumber);
        }
    } catch (err) {
        console.error('Failed to get pairing code:', err);
    }
    res.redirect('/');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Dashboard server running on port ${PORT}`);
    startBot();
});
