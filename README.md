# LiveChat Server

## Déploiement sur Railway (gratuit)

1. Crée un compte sur https://railway.app
2. New Project → Deploy from GitHub repo  
   (ou "Deploy from template" → Node.js)
3. Upload ces fichiers : server.js + package.json
4. Dans Railway → Variables, ajoute :
   - `DISCORD_TOKEN` = ton token bot Discord
   - `CLIENT_ID` = ton Application ID Discord
5. Deploy → copie l'URL générée (ex: https://livechat-xxx.railway.app)

## Cette URL, tu la donnes à tes amis dans l'app.

C'est tout.
