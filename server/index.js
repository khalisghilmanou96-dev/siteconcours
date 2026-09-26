import 'dotenv/config'
import express from 'express'
import Stripe from 'stripe'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { snapshot, transaction } from './store.js'

const app = express()
const port = Number(process.env.PORT || 4242)
const maxTickets = Number(process.env.MAX_TICKETS || 500)
const priceEur = Number(process.env.TICKET_PRICE_EUR || 10)
const appUrl = (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '')
const stripeKey = process.env.STRIPE_SECRET_KEY
const stripe = stripeKey ? new Stripe(stripeKey) : null

function clean(v, max = 180) { return String(v || '').trim().slice(0, max) }
function validEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) }

// IMPORTANT : webhook AVANT express.json(), Stripe exige le corps brut pour vérifier la signature.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send('Stripe non configuré')
  let event
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET)
  } catch (err) { return res.status(400).send(`Webhook invalide: ${err.message}`) }

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object
    if (session.payment_status === 'paid') {
      let formspreePayload = null
      await transaction(async db => {
        if (db.processedEvents[event.id]) return
        db.processedEvents[event.id] = new Date().toISOString()
        if (db.payments[session.id]) return
        const pending = db.pending[session.id]
        if (!pending) return
        if (Number(session.amount_total) !== Math.round(priceEur * 100) || String(session.currency).toLowerCase() !== 'eur') return
        if (db.nextTicket > maxTickets) return
        const ticketNumber = db.nextTicket++
        const paidAt = new Date().toISOString()
        db.payments[session.id] = { ...pending, ticketNumber, paidAt, paymentIntent: session.payment_intent }
        delete db.pending[session.id]
        formspreePayload = { ...pending, ticketNumber, paidAt, stripeSessionId: session.id, paymentStatus: 'paid', amount: `${priceEur} EUR` }
      })
      if (formspreePayload && process.env.FORMSPREE_FORM_ID) {
        try {
          const r = await fetch(`https://formspree.io/f/${encodeURIComponent(process.env.FORMSPREE_FORM_ID)}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(formspreePayload)
          })
          if (!r.ok) console.error('Formspree:', r.status, await r.text())
        } catch (e) { console.error('Formspree indisponible:', e.message) }
      }
    }
  }
  res.json({ received: true })
})

app.use(express.json({ limit: '20kb' }))

app.get('/api/tickets/status', async (_req, res) => {
  const db = await snapshot()
  const sold = Math.min(maxTickets, Math.max(0, db.nextTicket - 1))
  res.json({ sold, max: maxTickets, remaining: Math.max(0, maxTickets - sold) })
})

app.post('/api/create-checkout-session', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'STRIPE_SECRET_KEY manquante dans .env' })
  const firstName = clean(req.body.firstName, 80), lastName = clean(req.body.lastName, 80)
  const email = clean(req.body.email, 180), phone = clean(req.body.phone, 40)
  if (!firstName || !lastName || !validEmail(email) || !phone) return res.status(400).json({ error: 'Coordonnées invalides.' })

  const db = await snapshot()
  if (db.nextTicket > maxTickets) return res.status(409).json({ error: 'Les 500 tickets ont été vendus.' })

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      line_items: [{ price_data: { currency: 'eur', unit_amount: Math.round(priceEur * 100), product_data: { name: 'Participation concours Dubaï', description: '1 ticket de participation' } }, quantity: 1 }],
      success_url: `${appUrl}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/?payment=cancelled#participer`,
      metadata: { source: 'concours-dubai' }
    })
    await transaction(async data => { data.pending[session.id] = { firstName, lastName, email, phone, createdAt: new Date().toISOString() } })
    res.json({ url: session.url })
  } catch (e) { console.error(e); res.status(500).json({ error: 'Impossible de créer la session Stripe.' }) }
})

app.get('/api/payment-status', async (req, res) => {
  const id = clean(req.query.session_id, 255)
  if (!id) return res.status(400).json({ error: 'session_id manquant' })
  const db = await snapshot()
  const paid = db.payments[id]
  res.json(paid ? { paid: true, ticketNumber: paid.ticketNumber, firstName: paid.firstName } : { paid: false })
})

if (process.env.NODE_ENV === 'production') {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
  app.use(express.static(root))
  app.get('*', (_req, res) => res.sendFile(path.join(root, 'index.html')))
}
app.listen(port, () => console.log(`API Stripe: http://localhost:${port}`))
