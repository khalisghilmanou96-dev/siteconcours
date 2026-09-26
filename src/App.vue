<script setup>
import { computed, onMounted, ref } from 'vue'
import heroTicket from './assets/hero-ticket.png'
import partnerShowcase from './assets/partner-showcase.png'
import partnerLogo from './assets/partner-logo.png'

const MAX_TICKETS = 500
const sold = ref(0)
const loading = ref(true)
const checkoutLoading = ref(false)
const checkoutError = ref('')
const payment = ref({ checking:false, paid:false, ticketNumber:null, firstName:'' })
const form = ref({ firstName:'', lastName:'', email:'', phone:'' })
const percent = computed(() => Math.min(100, Math.round((sold.value / MAX_TICKETS) * 100)))
const remaining = computed(() => Math.max(0, MAX_TICKETS - sold.value))

async function refreshProgress(){
  loading.value = true
  try {
    // À connecter à votre backend. Le backend compte uniquement les paiements Stripe confirmés par webhook.
    const r = await fetch('/api/tickets/status')
    if (r.ok) {
      const data = await r.json()
      sold.value = Math.max(0, Math.min(MAX_TICKETS, Number(data.sold || 0)))
    }
  } catch (_) {
    // V1/V3 locale : reste à 0 si l'API n'est pas encore branchée.
  } finally { loading.value = false }
}

async function checkout(){
  checkoutError.value = ''
  checkoutLoading.value = true
  try {
    const r = await fetch('/api/create-checkout-session', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({...form.value, quantity:1})
    })
    const data = await r.json()
    if (!r.ok) throw new Error(data.error || 'Impossible de lancer le paiement.')
    if (data.url) window.location.assign(data.url)
  } catch (e) { checkoutError.value = e.message }
  finally { checkoutLoading.value = false }
}

async function checkPaymentReturn(){
  const params = new URLSearchParams(location.search)
  if (params.get('payment') !== 'success' || !params.get('session_id')) return
  payment.value.checking = true
  // Le webhook peut arriver quelques instants après la redirection Stripe.
  for (let i=0; i<8; i++) {
    try {
      const r = await fetch(`/api/payment-status?session_id=${encodeURIComponent(params.get('session_id'))}`)
      const data = await r.json()
      if (data.paid) {
        payment.value = { checking:false, paid:true, ticketNumber:data.ticketNumber, firstName:data.firstName || '' }
        await refreshProgress()
        return
      }
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 1200))
  }
  payment.value.checking = false
}

onMounted(async () => { await refreshProgress(); await checkPaymentReturn() })
</script>

<template>
  <main>
    <section v-if="payment.paid" class="payment-banner wrap" role="status">
      <strong>Paiement confirmé{{ payment.firstName ? `, ${payment.firstName}` : '' }}.</strong>
      Ticket de participation n° {{ payment.ticketNumber }} validé. Le compteur a été actualisé automatiquement.
    </section>
    <section v-else-if="payment.checking" class="payment-banner wrap">Confirmation du paiement Stripe en cours…</section>
    <header class="topbar">
      <img :src="partnerLogo" alt="Dubai Rental Car" class="brand" />
      <a href="#participer" class="btn btn-small">PARTICIPER — 10 €</a>
    </header>

    <section class="hero wrap">
      <img :src="heroTicket" alt="Gagne tes billets aller-retour pour Dubaï" class="hero-art" />
      <div class="eyebrow">JEU CONCOURS • 500 TICKETS MAXIMUM</div>
      <h1>TON ALLER-RETOUR POUR <span>DUBAÏ</span></h1>
      <p class="lead">1 ticket = 10 €. Le tirage au sort est prévu le <strong>31 décembre 2026</strong>. Le gagnant sera contacté après le tirage.</p>
      <a href="#participer" class="btn">JE PRENDS MON TICKET — 10 €</a>
    </section>

    <section class="progress-section wrap" aria-label="Progression des tickets vendus">
      <div class="progress-head"><strong>{{ loading ? 'Actualisation…' : `${sold} / ${MAX_TICKETS} tickets validés` }}</strong><span>{{ percent }} %</span></div>
      <div class="track"><div class="fill" :style="{width: percent + '%'}"></div></div>
      <p>{{ remaining }} tickets encore disponibles. Le compteur est alimenté uniquement par les paiements confirmés par Stripe.</p>
    </section>

    <section id="participer" class="entry wrap">
      <div>
        <div class="eyebrow">PARTICIPATION</div>
        <h2>Réserve ton ticket</h2>
        <p>Renseigne tes coordonnées puis passe au paiement sécurisé. Ta participation n'est comptabilisée qu'après confirmation du paiement.</p>
      </div>
      <form @submit.prevent="checkout" class="form-card">
        <div class="grid"><input v-model="form.firstName" required placeholder="Prénom"><input v-model="form.lastName" required placeholder="Nom"></div>
        <input v-model="form.email" required type="email" placeholder="E-mail">
        <input v-model="form.phone" required type="tel" placeholder="Téléphone">
        <label class="check"><input required type="checkbox"> <span>J'accepte le règlement du jeu et la politique de confidentialité.</span></label>
        <button class="btn full" type="submit" :disabled="checkoutLoading || remaining === 0">{{ checkoutLoading ? 'REDIRECTION VERS STRIPE…' : remaining === 0 ? 'COMPLET' : 'PAYER 10 € AVEC STRIPE' }}</button>
        <p v-if="checkoutError" class="form-error">{{ checkoutError }}</p>
        <small>Paiement sécurisé • 1 ticket par paiement • Formspree reçoit les coordonnées uniquement après confirmation Stripe</small>
      </form>
    </section>

    <section class="partner wrap">
      <div class="eyebrow">PARTENAIRE / ORGANISATEUR</div>
      <img :src="partnerLogo" alt="Logo Dubai Rental Car" class="partner-logo" />
      <p>Dubai Rental Car accompagne l'opération. Les informations légales définitives de l'organisateur, du lot et du règlement seront à compléter avant mise en production.</p>
      <img :src="partnerShowcase" alt="Présentation Dubai Rental Car, véhicules et services" class="partner-showcase" />
    </section>

    <section class="how wrap">
      <div><b>01</b><h3>Remplis le formulaire</h3><p>Coordonnées nécessaires à ta participation.</p></div>
      <div><b>02</b><h3>Paie via Stripe</h3><p>Le ticket coûte 10 €.</p></div>
      <div><b>03</b><h3>Validation automatique</h3><p>Le webhook Stripe confirme le paiement et incrémente le compteur.</p></div>
    </section>

    <footer>Concours Dubaï • Tirage au sort prévu le 31 décembre 2026 • Mentions légales et règlement à finaliser avant publication.</footer>
  </main>
</template>
