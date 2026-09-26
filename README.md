# Concours Dubaï — version finale Stripe + Formspree

## 1. Installation
```bash
npm install
cp .env.example .env
```

## 2. Configuration `.env`
Renseigner :
- `STRIPE_SECRET_KEY` : clé secrète Stripe `sk_test_...` en test puis `sk_live_...` en production.
- `STRIPE_WEBHOOK_SECRET` : secret de signature du webhook `whsec_...`.
- `APP_URL` : `http://localhost:5173` en développement, puis l'URL HTTPS du site en production.
- `FORMSPREE_FORM_ID` : uniquement l'identifiant de votre formulaire Formspree (la partie après `/f/`).

Ne jamais mettre la clé Stripe secrète dans une variable `VITE_*` ou dans `App.vue`.

## 3. Développement
```bash
npm run dev
```
Vite : http://localhost:5173 — API : http://localhost:4242

### Webhook Stripe local
Avec Stripe CLI connecté :
```bash
stripe listen --forward-to localhost:4242/api/stripe/webhook
```
Copier le `whsec_...` affiché dans `.env`, puis relancer `npm run dev`.

## 4. Webhook Stripe en production
Créer dans Stripe un endpoint :
`https://VOTRE-DOMAINE/api/stripe/webhook`

Événements utilisés :
- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`

Copier le secret de signature de cet endpoint dans `STRIPE_WEBHOOK_SECRET`.

## 5. Formspree
Créer un formulaire Formspree et placer son ID dans `FORMSPREE_FORM_ID`. Les coordonnées ne sont envoyées à Formspree qu'après un paiement Stripe confirmé par webhook, avec le numéro de ticket, l'identifiant de session Stripe et le statut payé.

## 6. Production
```bash
npm run build
npm start
```
Le serveur Express sert alors `dist/` et les routes `/api/*` sur `PORT` (4242 par défaut). Définir `APP_URL` avec l'URL HTTPS publique.

## Compteur / 500 tickets
`server/data/store.json` est créé automatiquement au premier lancement et n'est pas versionné. Le webhook attribue les numéros 1 à 500 de façon idempotente et le front lit `/api/tickets/status`. Une simple redirection/recharge navigateur ne peut pas incrémenter le compteur.

### Important avant lancement réel
Cette version utilise un stockage JSON local, adapté à un déploiement **mono-instance avec disque persistant**. Sur Vercel/serverless ou plusieurs instances, remplacer `server/store.js` par une base transactionnelle persistante (Postgres, MySQL, etc.) avant d'accepter des paiements réels. Vérifier également le règlement et la conformité juridique du jeu payant dans les juridictions ciblées ainsi que l'éligibilité du modèle auprès de Stripe.
