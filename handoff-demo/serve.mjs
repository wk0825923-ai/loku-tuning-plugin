// 手動起動用：node serve.mjs → http://127.0.0.1:8787 で待受け
import { createServer } from './app.mjs';
const PORT = Number(process.env.PORT || 8787);
const server = createServer({ allowShutdown: process.env.ALLOW_SHUTDOWN === '1' });
server.listen(PORT, () => console.log(`Loku Attention demo API listening on http://127.0.0.1:${PORT}`));
