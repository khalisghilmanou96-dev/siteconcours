import 'dotenv/config'
import express from 'express'
import Stripe from 'stripe'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { snapshot, transaction } from './store.js'

const app = express()

// =====================================================
// CONFIGURATION
// =====================================================

const port = Number(process.env.PORT || 4242)

const maxParticipations = Number(
  process.env.MAX_TICKETS || 500
)

const priceEur = Number(
  process.env.TICKET_PRICE_EUR || 10
)

const appUrl = (
  process.env.APP_URL || 'http://localhost:5173'
).replace(/\/$/, '')

const stripeKey =
  process.env.STRIPE_SECRET_KEY

const stripe = stripeKey
  ? new Stripe(stripeKey)
  : null


// =====================================================
// OUTILS
// =====================================================

function clean(value, max = 180) {
  return String(value || '')
    .trim()
    .slice(0, max)
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}


// =====================================================
// WEBHOOK STRIPE
//
// IMPORTANT :
// cette route doit être AVANT express.json()
// car Stripe exige le corps brut de la requête.
// =====================================================

app.post(
  '/api/stripe/webhook',

  express.raw({
    type: 'application/json'
  }),

  async (req, res) => {

    if (
      !stripe ||
      !process.env.STRIPE_WEBHOOK_SECRET
    ) {
      console.error(
        'Webhook Stripe non configuré.'
      )

      return res
        .status(503)
        .send('Stripe non configuré')
    }


    let event


    // -------------------------------------------------
    // Vérification signature Stripe
    // -------------------------------------------------

    try {

      event =
        stripe.webhooks.constructEvent(
          req.body,
          req.headers['stripe-signature'],
          process.env.STRIPE_WEBHOOK_SECRET
        )

    } catch (error) {

      console.error(
        'Erreur signature webhook Stripe:',
        error.message
      )

      return res
        .status(400)
        .send(
          `Webhook invalide: ${error.message}`
        )
    }


    console.log(
      'Webhook Stripe reçu:',
      event.type
    )


    // -------------------------------------------------
    // Événements de paiement acceptés
    // -------------------------------------------------

    const acceptedEvents = [
      'checkout.session.completed',
      'checkout.session.async_payment_succeeded'
    ]


    if (
      acceptedEvents.includes(event.type)
    ) {

      const session =
        event.data.object


      if (
        session.payment_status === 'paid'
      ) {

        let formspreePayload = null


        try {

          await transaction(
            async (db) => {

              // ---------------------------------------
              // Initialise les propriétés si nécessaire
              // ---------------------------------------

              if (!db.processedEvents) {
                db.processedEvents = {}
              }

              if (!db.participations) {
                db.participations = {}
              }

              if (!db.pending) {
                db.pending = {}
              }


              // ---------------------------------------
              // Évite de traiter 2 fois le même webhook
              // ---------------------------------------

              if (
                db.processedEvents[event.id]
              ) {

                console.log(
                  'Webhook déjà traité:',
                  event.id
                )

                return
              }


              // ---------------------------------------
              // Participation déjà enregistrée
              // ---------------------------------------

              if (
                db.participations[session.id]
              ) {

                db.processedEvents[event.id] =
                  new Date().toISOString()

                console.log(
                  'Participation déjà enregistrée:',
                  session.id
                )

                return
              }


              // ---------------------------------------
              // Retrouve les données du formulaire
              // ---------------------------------------

              const pending =
                db.pending[session.id]


              if (!pending) {

                console.warn(
                  'Aucune participation en attente pour:',
                  session.id
                )

                return
              }


              // ---------------------------------------
              // Vérification du montant
              // ---------------------------------------

              const expectedAmount =
                Math.round(
                  priceEur * 100
                )


              if (
                Number(session.amount_total) !==
                  expectedAmount ||
                String(
                  session.currency
                ).toLowerCase() !== 'eur'
              ) {

                console.error(
                  'Montant Stripe incorrect.',
                  {
                    sessionId:
                      session.id,

                    received:
                      session.amount_total,

                    expected:
                      expectedAmount,

                    currency:
                      session.currency
                  }
                )

                return
              }


              // ---------------------------------------
              // Maximum 500 participations
              // ---------------------------------------

              const validatedCount =
                Object.keys(
                  db.participations
                ).length


              if (
                validatedCount >=
                maxParticipations
              ) {

                console.warn(
                  'Maximum de participations atteint.'
                )

                return
              }


              // ---------------------------------------
              // Validation participation
              // ---------------------------------------

              const paidAt =
                new Date().toISOString()


              db.participations[
                session.id
              ] = {

                ...pending,

                paidAt,

                paymentIntent:
                  session.payment_intent ||
                  null
              }


              // Supprime la participation en attente

              delete db.pending[
                session.id
              ]


              // Marque le webhook comme traité

              db.processedEvents[
                event.id
              ] = paidAt


              // ---------------------------------------
              // Données envoyées à Formspree
              // ---------------------------------------

              formspreePayload = {

                firstName:
                  pending.firstName,

                lastName:
                  pending.lastName,

                email:
                  pending.email,

                phone:
                  pending.phone,

                paidAt,

                stripeSessionId:
                  session.id,

                paymentIntent:
                  session.payment_intent ||
                  '',

                paymentStatus:
                  'paid',

                amount:
                  `${priceEur} EUR`,

                concours:
                  'Concours Dubaï'
              }
            }
          )

        } catch (error) {

          console.error(
            'Erreur enregistrement participation:',
            error
          )

          return res
            .status(500)
            .json({
              error:
                'Erreur serveur pendant la validation.'
            })
        }


        // =================================================
        // FORMSPREE
        // =================================================

        if (formspreePayload) {

          if (
            !process.env.FORMSPREE_FORM_ID
          ) {

            console.error(
              'FORMSPREE_FORM_ID non configuré.'
            )

          } else {

            try {

              const formspreeResponse =
                await fetch(
                  `https://formspree.io/f/${encodeURIComponent(
                    process.env.FORMSPREE_FORM_ID
                  )}`,
                  {
                    method: 'POST',

                    headers: {
                      'Content-Type':
                        'application/json',

                      Accept:
                        'application/json'
                    },

                    body:
                      JSON.stringify(
                        formspreePayload
                      )
                  }
                )


              if (
                !formspreeResponse.ok
              ) {

                const responseText =
                  await formspreeResponse.text()

                console.error(
                  'Erreur Formspree:',
                  formspreeResponse.status,
                  responseText
                )

              } else {

                console.log(
                  'Formspree envoyé avec succès:',
                  session.id
                )

              }

            } catch (error) {

              console.error(
                'Formspree indisponible:',
                error.message
              )

            }

          }

        }


        console.log(
          'Participation validée:',
          session.id
        )

      }

    }


    return res.json({
      received: true
    })

  }
)


// =====================================================
// JSON POUR LES AUTRES ROUTES
// =====================================================

app.use(
  express.json({
    limit: '20kb'
  })
)


// =====================================================
// COMPTEUR DES PARTICIPATIONS
// =====================================================

app.get(
  '/api/participations/status',

  async (_req, res) => {

    try {

      const db =
        await snapshot()


      const participations =
        db.participations || {}


      const validated =
        Math.min(
          maxParticipations,
          Object.keys(
            participations
          ).length
        )


      return res.json({

        validated,

        max:
          maxParticipations,

        remaining:
          Math.max(
            0,
            maxParticipations -
              validated
          )

      })

    } catch (error) {

      console.error(
        'Erreur lecture participations:',
        error
      )


      return res
        .status(500)
        .json({
          error:
            'Erreur serveur'
        })

    }

  }
)


// =====================================================
// CRÉATION DE LA SESSION STRIPE CHECKOUT
// =====================================================

app.post(
  '/api/create-checkout-session',

  async (req, res) => {

    if (!stripe) {

      return res
        .status(503)
        .json({
          error:
            'STRIPE_SECRET_KEY manquante dans les variables d’environnement.'
        })

    }


    // -------------------------------------------------
    // Données formulaire
    // -------------------------------------------------

    const firstName =
      clean(
        req.body.firstName,
        80
      )

    const lastName =
      clean(
        req.body.lastName,
        80
      )

    const email =
      clean(
        req.body.email,
        180
      )

    const phone =
      clean(
        req.body.phone,
        40
      )


    if (
      !firstName ||
      !lastName ||
      !validEmail(email) ||
      !phone
    ) {

      return res
        .status(400)
        .json({
          error:
            'Coordonnées invalides.'
        })

    }


    try {

      // -------------------------------------------------
      // Vérification places disponibles
      // -------------------------------------------------

      const db =
        await snapshot()


      const participations =
        db.participations || {}


      const validatedCount =
        Object.keys(
          participations
        ).length


      if (
        validatedCount >=
        maxParticipations
      ) {

        return res
          .status(409)
          .json({
            error:
              'Les 500 participations ont déjà été validées.'
          })

      }


      // =================================================
      // CRÉATION STRIPE CHECKOUT
      // =================================================

      const session =
        await stripe
          .checkout
          .sessions
          .create({

            mode:
              'payment',


            /*
             * Désactive Managed Payments pour cette
             * session afin d'éviter l'obligation
             * du tax_code rencontrée précédemment.
             */

            managed_payments: {
              enabled: false
            },


            customer_email:
              email,


            line_items: [

              {

                price_data: {

                  currency:
                    'eur',

                  unit_amount:
                    Math.round(
                      priceEur * 100
                    ),

                  product_data: {

                    name:
                      'Participation concours Dubaï',

                    description:
                      '1 participation au concours'

                  }

                },

                quantity: 1

              }

            ],


            // -------------------------------------------
            // REDIRECTION APRÈS PAIEMENT
            // -------------------------------------------

            success_url:
              `${appUrl}/merci.html` +
              `?session_id={CHECKOUT_SESSION_ID}`,


            // -------------------------------------------
            // RETOUR SI ANNULATION
            // -------------------------------------------

            cancel_url:
              `${appUrl}/?payment=cancelled#participer`,


            metadata: {
              source:
                'concours-dubai'
            }

          })


      // -------------------------------------------------
      // Sauvegarde temporaire du formulaire
      // -------------------------------------------------

      await transaction(
        async (data) => {

          if (!data.pending) {
            data.pending = {}
          }

          data.pending[
            session.id
          ] = {

            firstName,

            lastName,

            email,

            phone,

            createdAt:
              new Date()
                .toISOString()

          }

        }
      )


      console.log(
        'Session Stripe créée:',
        session.id
      )


      return res.json({
        url:
          session.url
      })


    } catch (error) {

      console.error(
        'Erreur création Stripe Checkout:',
        error
      )


      return res
        .status(500)
        .json({
          error:
            'Impossible de créer la session Stripe.'
        })

    }

  }
)


// =====================================================
// VÉRIFICATION DU PAIEMENT POUR merci.html
// =====================================================

app.get(
  '/api/payment-status',

  async (req, res) => {

    const sessionId =
      clean(
        req.query.session_id,
        255
      )


    if (!sessionId) {

      return res
        .status(400)
        .json({
          error:
            'session_id manquant'
        })

    }


    try {

      const db =
        await snapshot()


      const participations =
        db.participations || {}


      const paid =
        participations[
          sessionId
        ]


      if (paid) {

        return res.json({

          paid:
            true,

          firstName:
            paid.firstName

        })

      }


      return res.json({
        paid: false
      })


    } catch (error) {

      console.error(
        'Erreur vérification paiement:',
        error
      )


      return res
        .status(500)
        .json({
          error:
            'Erreur serveur'
        })

    }

  }
)


// =====================================================
// FRONTEND EN PRODUCTION
// =====================================================

if (
  process.env.NODE_ENV ===
  'production'
) {

  const root =
    path.resolve(
      path.dirname(
        fileURLToPath(
          import.meta.url
        )
      ),
      '..',
      'dist'
    )


  // Sert index.html, merci.html, merci.png, assets...
  app.use(
    express.static(root)
  )


  /*
   * Fallback Vue.
   *
   * IMPORTANT :
   * on n'utilise PAS app.get('*')
   * car ta version d'Express/path-to-regexp
   * avait déjà provoqué une erreur Render.
   */

  app.use(
    (req, res, next) => {

      if (
        req.path.startsWith(
          '/api/'
        )
      ) {
        return next()
      }


      if (
        req.method !== 'GET'
      ) {
        return next()
      }


      return res.sendFile(
        path.join(
          root,
          'index.html'
        )
      )

    }
  )

}


// =====================================================
// API 404
// =====================================================

app.use(
  '/api',

  (_req, res) => {

    return res
      .status(404)
      .json({
        error:
          'Route API introuvable'
      })

  }
)


// =====================================================
// DÉMARRAGE SERVEUR
// =====================================================

app.listen(
  port,
  '0.0.0.0',

  () => {

    console.log(
      `Serveur démarré sur le port ${port}`
    )

    console.log(
      `Prix participation : ${priceEur} EUR`
    )

    console.log(
      `Maximum participations : ${maxParticipations}`
    )

    console.log(
      `APP_URL : ${appUrl}`
    )


    if (!stripeKey) {

      console.warn(
        'STRIPE_SECRET_KEY non configurée'
      )

    }


    if (
      !process.env
        .STRIPE_WEBHOOK_SECRET
    ) {

      console.warn(
        'STRIPE_WEBHOOK_SECRET non configuré'
      )

    }


    if (
      !process.env
        .FORMSPREE_FORM_ID
    ) {

      console.warn(
        'FORMSPREE_FORM_ID non configuré'
      )

    }

  }
)