/* ============================================================
   COMBAT COVER — shared Shopify Storefront API cart
   Included on index.html, product.html, about.html.
   Renders the cart icon badge + slide-in drawer, and exposes
   window.CombatCart.addLine(variantId, quantity) for the
   product page's Add to Cart button.
   ============================================================ */

const SHOPIFY_DOMAIN     = 'combatcovers.myshopify.com'
const STOREFRONT_TOKEN   = '0be313c278f70638f85ff750165d5a3d'
const STOREFRONT_VERSION = '2024-10'

const STOREFRONT_URL = `https://${SHOPIFY_DOMAIN}/api/${STOREFRONT_VERSION}/graphql.json`
const CART_ID_KEY = 'cc_cart_id'

async function shopifyFetch(query, variables) {
  const res = await fetch(STOREFRONT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': STOREFRONT_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  })
  const json = await res.json()
  if (json.errors) throw new Error(json.errors[0]?.message || 'Shopify API error')
  return json.data
}

const CART_FIELDS = `
  id
  checkoutUrl
  totalQuantity
  cost { totalAmount { amount currencyCode } }
  lines(first: 20) {
    edges {
      node {
        id
        quantity
        merchandise {
          ... on ProductVariant {
            price { amount currencyCode }
            product { title featuredImage { url altText } }
          }
        }
      }
    }
  }
`

// Thrown when a cart is no longer usable (completed/expired) so callers can
// tell this apart from an ordinary validation error (e.g. out-of-stock).
class CartExpiredError extends Error {}

async function getOrCreateCart() {
  const existingId = localStorage.getItem(CART_ID_KEY)
  if (existingId) {
    const data = await shopifyFetch(
      `query getCart($id: ID!) { cart(id: $id) { ${CART_FIELDS} } }`,
      { id: existingId }
    )
    if (data.cart) return data.cart
  }
  const data = await shopifyFetch(
    `mutation { cartCreate { cart { ${CART_FIELDS} } userErrors { field message } } }`,
    {}
  )
  const createErrors = data.cartCreate.userErrors
  if (createErrors.length) throw new Error(createErrors[0].message)
  const cart = data.cartCreate.cart
  if (!cart) throw new Error('Could not create cart')
  localStorage.setItem(CART_ID_KEY, cart.id)
  return cart
}

// retry: true means "if this cart is invalid/completed, clear it and try once
// more with a fresh cart" — safe here because adding the line the user just
// clicked into a new cart doesn't lose anything they didn't just ask to add.
async function addLineToCart(variantId, quantity, retry = true) {
  const cart = await getOrCreateCart()
  const data = await shopifyFetch(
    `mutation addLine($cartId: ID!, $lines: [CartLineInput!]!) {
       cartLinesAdd(cartId: $cartId, lines: $lines) {
         cart { ${CART_FIELDS} }
         userErrors { field message }
       }
     }`,
    { cartId: cart.id, lines: [{ merchandiseId: variantId, quantity }] }
  )
  const errors = data.cartLinesAdd.userErrors
  if (errors.length) {
    if (retry) {
      const hadOtherLines = (cart.lines?.edges.length || 0) > 0
      localStorage.removeItem(CART_ID_KEY)
      const freshCart = await addLineToCart(variantId, quantity, false)
      freshCart.wasReset = hadOtherLines
      return freshCart
    }
    throw new Error(errors[0].message)
  }
  const resultCart = data.cartLinesAdd.cart
  if (!resultCart) throw new Error('Could not update cart')
  return resultCart
}

// Quantity changes/removals can't be safely "replayed" into a brand new cart
// (the line being edited wouldn't exist there), so an invalid cart here is
// surfaced as a clear, catchable error instead of silently doing nothing.
async function updateLineQuantity(cartId, lineId, quantity) {
  const data = await shopifyFetch(
    `mutation updateLine($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
       cartLinesUpdate(cartId: $cartId, lines: $lines) {
         cart { ${CART_FIELDS} }
         userErrors { field message }
       }
     }`,
    { cartId, lines: [{ id: lineId, quantity }] }
  )
  const errors = data.cartLinesUpdate.userErrors
  if (errors.length) {
    localStorage.removeItem(CART_ID_KEY)
    throw new CartExpiredError(errors[0].message)
  }
  return data.cartLinesUpdate.cart
}

async function removeLine(cartId, lineId) {
  const data = await shopifyFetch(
    `mutation removeLine($cartId: ID!, $lineIds: [ID!]!) {
       cartLinesRemove(cartId: $cartId, lineIds: $lineIds) {
         cart { ${CART_FIELDS} }
         userErrors { field message }
       }
     }`,
    { cartId, lineIds: [lineId] }
  )
  const errors = data.cartLinesRemove.userErrors
  if (errors.length) {
    localStorage.removeItem(CART_ID_KEY)
    throw new CartExpiredError(errors[0].message)
  }
  return data.cartLinesRemove.cart
}

/* ─── Drawer DOM (built once, lazily) ────────────────────────── */
let drawerEls = null

function buildDrawer() {
  const overlay = document.createElement('div')
  overlay.className = 'cart-overlay'

  const drawer = document.createElement('div')
  drawer.className = 'cart-drawer'
  drawer.innerHTML = `
    <div class="cart-drawer-head">
      <h3>Your Cart</h3>
      <button class="cart-drawer-close" aria-label="Close cart">&times;</button>
    </div>
    <p class="cart-notice" style="display:none;"></p>
    <div class="cart-drawer-body"></div>
    <div class="cart-drawer-foot" style="display:none;">
      <div class="cart-subtotal"><span>Subtotal</span><span class="cart-subtotal-amount"></span></div>
      <a href="#" class="cart-checkout-btn" target="_blank" rel="noopener">Checkout →</a>
    </div>
  `
  document.body.appendChild(overlay)
  document.body.appendChild(drawer)

  overlay.addEventListener('click', closeDrawer)
  drawer.querySelector('.cart-drawer-close').addEventListener('click', closeDrawer)

  return { overlay, drawer }
}

function ensureDrawer() {
  if (!drawerEls) drawerEls = buildDrawer()
  return drawerEls
}

function openDrawer() {
  const { overlay, drawer } = ensureDrawer()
  overlay.classList.add('open')
  drawer.classList.add('open')
  document.body.style.overflow = 'hidden'
}

function closeDrawer() {
  if (!drawerEls) return
  drawerEls.overlay.classList.remove('open')
  drawerEls.drawer.classList.remove('open')
  document.body.style.overflow = ''
}

function showNotice(message) {
  const { drawer } = ensureDrawer()
  const notice = drawer.querySelector('.cart-notice')
  notice.textContent = message
  notice.style.display = 'block'
}

function clearNotice() {
  if (!drawerEls) return
  drawerEls.drawer.querySelector('.cart-notice').style.display = 'none'
}

/* ─── Render cart contents into the drawer + badge ──────────── */
function renderCart(cart) {
  const { drawer } = ensureDrawer()
  const body = drawer.querySelector('.cart-drawer-body')
  const foot = drawer.querySelector('.cart-drawer-foot')
  clearNotice()

  const allLines = cart?.lines?.edges || []
  // A line's merchandise can be null if that variant/product was deleted or
  // unpublished in Shopify after it was added to this cart.
  const lines = allLines.filter(({ node }) => node.merchandise)

  updateBadge(cart?.totalQuantity || 0)

  if (!cart || lines.length === 0) {
    body.innerHTML = '<p class="cart-empty">Your cart is empty.</p>'
    foot.style.display = 'none'
    if (allLines.length > lines.length) {
      showNotice('One or more items in your cart are no longer available and were removed from view.')
    }
    return
  }

  body.innerHTML = lines.map(({ node: line }) => {
    const variant = line.merchandise
    const img = variant.product.featuredImage
    return `
      <div class="cart-line">
        ${img ? `<img class="cart-line-img" src="${img.url}" alt="${img.altText || ''}">` : ''}
        <div class="cart-line-info">
          <span class="cart-line-title">${variant.product.title}</span>
          <span class="cart-line-price">$${Number(variant.price.amount).toFixed(2)}</span>
          <div class="cart-line-qty">
            <button class="cart-qty-minus" data-line-id="${line.id}" data-qty="${line.quantity - 1}">−</button>
            <span>${line.quantity}</span>
            <button class="cart-qty-plus" data-line-id="${line.id}" data-qty="${line.quantity + 1}">+</button>
          </div>
          <button class="cart-line-remove" data-line-id="${line.id}">Remove</button>
        </div>
      </div>
    `
  }).join('')

  foot.style.display = 'block'
  drawer.querySelector('.cart-subtotal-amount').textContent = `$${Number(cart.cost.totalAmount.amount).toFixed(2)}`
  drawer.querySelector('.cart-checkout-btn').href = cart.checkoutUrl

  if (allLines.length > lines.length) {
    showNotice('One or more items in your cart are no longer available and were removed from view.')
  } else if (cart.wasReset) {
    showNotice('Your previous cart session had expired, so a new cart was started.')
  }

  body.querySelectorAll('.cart-qty-minus, .cart-qty-plus').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true
      const lineId = btn.dataset.lineId
      const newQty = parseInt(btn.dataset.qty)
      try {
        const updated = newQty < 1
          ? await removeLine(cart.id, lineId)
          : await updateLineQuantity(cart.id, lineId, newQty)
        renderCart(updated)
      } catch (err) {
        console.error(err)
        showNotice(err instanceof CartExpiredError
          ? 'Your cart session expired. Please reopen the cart and add your items again.'
          : err.message || 'Something went wrong updating your cart.')
        btn.disabled = false
      }
    })
  })
  body.querySelectorAll('.cart-line-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true
      try {
        const updated = await removeLine(cart.id, btn.dataset.lineId)
        renderCart(updated)
      } catch (err) {
        console.error(err)
        showNotice(err instanceof CartExpiredError
          ? 'Your cart session expired. Please reopen the cart and add your items again.'
          : err.message || 'Something went wrong updating your cart.')
        btn.disabled = false
      }
    })
  })
}

function updateBadge(count) {
  document.querySelectorAll('.cart-badge').forEach(badge => {
    badge.textContent = count
    badge.classList.toggle('show', count > 0)
  })
}

/* ─── Cart icon buttons in the nav (desktop + mobile share one) ─ */
document.querySelectorAll('.cart-toggle').forEach(btn => {
  btn.addEventListener('click', async () => {
    openDrawer()
    try {
      renderCart(await getOrCreateCart())
    } catch (err) {
      console.error(err)
      showNotice('Could not load your cart. Please try again.')
    }
  })
})

/* ─── Public entry point used by product.html's Add to Cart button ─── */
window.CombatCart = {
  addLine: async (variantId, quantity) => {
    const cart = await addLineToCart(variantId, quantity)
    renderCart(cart)
    openDrawer()
    return cart
  },
}

/* ─── Init: show the correct badge count on every page load ─── */
;(async () => {
  try {
    if (!localStorage.getItem(CART_ID_KEY)) return
    const cart = await getOrCreateCart()
    updateBadge(cart.totalQuantity)
  } catch (err) {
    console.error(err)
  }
})()
