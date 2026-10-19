import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEmail, mergeIntoOrders, removeAccount, setStatuses, cleanOrderNumber, repairOrderNumbers, explainEmail, SUBJECT_HINT, detectStatus, extractRetailer, extractItemCount, extractTracking, repairTracking, type RawEmail } from '../src/main/parser'

const mk = (over: Partial<RawEmail>): RawEmail => ({
  messageId: Math.random().toString(36),
  date: new Date('2026-10-01T12:00:00Z'),
  fromName: 'Amazon.com',
  fromAddress: 'auto-confirm@amazon.com',
  subject: '',
  text: '',
  ...over
})

test('amazon confirmation -> ordered', () => {
  const p = parseEmail(mk({ subject: 'Your Amazon.com order #112-1234567-7654321', text: 'Thanks for your order. Order Total: $45.99' }))
  assert.equal(p?.status, 'ordered')
  assert.equal(p?.orderNumber, '112-1234567-7654321')
  assert.equal(p?.retailer, 'Amazon')
  assert.equal(p?.total, '$45.99')
})

test('shipped with UPS tracking', () => {
  const p = parseEmail(mk({ fromName: 'Best Buy', fromAddress: 'BestBuyInfo@emailinfo.bestbuy.com', subject: 'Your order has shipped', text: 'Order #BBY01-806123456789. Tracking: 1Z999AA10123456784' }))
  assert.equal(p?.status, 'shipped')
  assert.equal(p?.orderNumber, 'BBY01-806123456789')
  assert.equal(p?.carrier, 'UPS')
})

test('cancelled beats footer text; delivered vs will-be-delivered', () => {
  assert.equal(detectStatus('Your order has been cancelled', ''), 'cancelled')
  assert.equal(detectStatus('Your order has shipped', 'To cancel your subscription click here'), 'shipped')
  assert.equal(detectStatus('Your package will be delivered Friday', ''), 'unknown')
  assert.equal(detectStatus('Delivered: your package', ''), 'delivered')
  assert.equal(detectStatus('Out for delivery: Order #4455', ''), 'out_for_delivery')
})

test('marketing email without order number is ignored', () => {
  assert.equal(parseEmail(mk({ subject: '50% off this weekend!', text: 'Shop now' })), null)
})

test('retailer from generic sender falls back to domain', () => {
  assert.equal(extractRetailer('no-reply', 'no-reply@ship.walmart.com'), 'Walmart')
  assert.equal(extractRetailer('Target', 'orders@target.com'), 'Target')
})

test('merge progresses status and is idempotent', () => {
  const a = parseEmail(mk({ messageId: 'a', subject: 'Order confirmation #A10001', date: new Date('2026-10-01') }))!
  const b = parseEmail(mk({ messageId: 'b', subject: 'Your order #A10001 has shipped', date: new Date('2026-10-03') }))!
  const c = parseEmail(mk({ messageId: 'c', subject: 'Delivered: order #A10001', date: new Date('2026-10-05') }))!
  let orders = mergeIntoOrders([], [b, a])
  assert.equal(orders.length, 1)
  assert.equal(orders[0].status, 'shipped')
  orders = mergeIntoOrders(orders, [c, c, a])
  assert.equal(orders[0].status, 'delivered')
  assert.equal(orders[0].events.length, 3)
})

test('manual status is not overwritten by sync', () => {
  const a = parseEmail(mk({ messageId: 'a', subject: 'Order confirmation #A20002' }))!
  const orders = mergeIntoOrders([], [a])
  orders[0].status = 'cancelled'; orders[0].manual = true
  const b = parseEmail(mk({ messageId: 'b', subject: 'Your order #A20002 has shipped' }))!
  assert.equal(mergeIntoOrders(orders, [b])[0].status, 'cancelled')
})

test('cancel phrasings are detected', () => {
  for (const s of [
    'Sorry, we had to cancel your order',
    'Sorry we had to cancel the order #12345',
    'We canceled your order',
    'Your order is being cancelled',
    'Order #5512 cancellation confirmation',
    "Your order couldn't be completed",
    'We were unable to fulfill your order',
    'CANCELED: Order 998877'
  ]) assert.equal(detectStatus(s, ''), 'cancelled', s)
  assert.equal(detectStatus('Update on your order #4455', 'Unfortunately we had to cancel this item.'), 'cancelled')
})

test('cancel email moves an ordered order to cancelled', () => {
  const a = parseEmail(mk({ messageId: 'a', subject: 'Order confirmation #A30003', date: new Date('2026-10-01') }))!
  const b = parseEmail(mk({ messageId: 'b', subject: 'Sorry, we had to cancel your order #A30003', date: new Date('2026-10-02') }))!
  assert.equal(b.status, 'cancelled')
  assert.equal(mergeIntoOrders([], [a, b])[0].status, 'cancelled')
})

test('confirmation body promising future shipping stays ordered', () => {
  assert.equal(detectStatus('Your order #A1234 is confirmed', "We'll email you when your order is on its way."), 'ordered')
  assert.equal(detectStatus('Thanks for your order', 'Once your order has shipped you will get tracking.'), 'ordered')
  assert.equal(detectStatus('Update on your order #4455', 'Good news: your order is on its way!'), 'shipped')
})

test('multi-account: same order in two inboxes merges, removing one account keeps the other', () => {
  const a = { ...parseEmail(mk({ messageId: 'm1', subject: 'Order confirmation #A40004', date: new Date('2026-10-01') }))!, account: 'acc1' }
  const dup = { ...a, account: 'acc2' } // same email forwarded to 2nd inbox
  const b = { ...parseEmail(mk({ messageId: 'm2', subject: 'Your order #A40004 has shipped', date: new Date('2026-10-03') }))!, account: 'acc2' }
  const c = { ...parseEmail(mk({ messageId: 'm3', subject: 'Order confirmation #B50005' }))!, account: 'acc2' }
  let orders = mergeIntoOrders([], [a, dup, b, c])
  assert.equal(orders.length, 2)
  const o = orders.find(x => x.orderNumber === 'A40004')!
  assert.deepEqual(o.accounts.sort(), ['acc1', 'acc2'])
  assert.equal(o.events.length, 2)
  assert.equal(o.status, 'shipped')
  orders = removeAccount(orders, 'acc2')
  assert.equal(orders.length, 1)
  assert.equal(orders[0].status, 'ordered')
  assert.deepEqual(orders[0].accounts, ['acc1'])
})

test('target: "items have arrived" is delivered and beats out for delivery', () => {
  const tgt = { fromName: 'Target', fromAddress: 'orders@oe.target.com' }
  const ofd = parseEmail(mk({ ...tgt, messageId: 't1', subject: 'Arriving today: order #912003456789', date: new Date('2026-10-05T09:00:00Z') }))!
  const arr = parseEmail(mk({ ...tgt, messageId: 't2', subject: 'Items have arrived from order 912003456789', date: new Date('2026-10-05T15:00:00Z') }))!
  assert.equal(ofd.status, 'out_for_delivery')
  assert.equal(arr.status, 'delivered')
  assert.equal(arr.orderNumber, '912003456789')
  const [o] = mergeIntoOrders([], [ofd, arr])
  assert.equal(o.status, 'delivered')
  assert.equal(o.events.length, 2)
})

test('other arrival / drop-off phrasings', () => {
  for (const s of ['Your package has arrived', 'Your items arrived!', 'Package dropped off: order #1234', 'Your order was picked up'])
    assert.equal(detectStatus(s, ''), 'delivered', s)
  assert.equal(detectStatus('Arriving today', ''), 'out_for_delivery')
  assert.equal(detectStatus('Your package will be delivered Friday', ''), 'unknown')
})

test('bulk status change and revert to auto', () => {
  const emails = ['C1001', 'C1002', 'C1003'].map((n, i) =>
    parseEmail(mk({ messageId: 'x' + i, subject: `Your order #${n} has shipped` }))!)
  let orders = mergeIntoOrders([], emails)
  const ids = orders.filter(o => o.orderNumber !== 'C1003').map(o => o.id)
  orders = setStatuses(orders, ids, 'delivered')
  assert.deepEqual(orders.map(o => [o.orderNumber, o.status, !!o.manual]).sort(),
    [['C1001', 'delivered', true], ['C1002', 'delivered', true], ['C1003', 'shipped', false]])
  orders = setStatuses(orders, ids, 'auto')
  assert.ok(orders.every(o => o.status === 'shipped' && !o.manual))
})

test('order number glued to the next word', () => {
  const tgt = { fromName: 'Target', fromAddress: 'orders@oe.target.com' }
  for (const [subject, text] of [
    ['Items from order #912003456789ARE about to ship', ''],
    ['Items from order #912003456789are about to ship', ''],
    ['Your Target order', 'Order #912003456789Your items are on the way'],
    ['Your Target order', 'order #912003456789 are about to ship']
  ]) assert.equal(parseEmail(mk({ ...tgt, subject, text }))?.orderNumber, '912003456789', subject + ' / ' + text)
  // Real IDs that contain letters are left alone.
  assert.equal(cleanOrderNumber('BBY01-806123456789'), 'BBY01-806123456789')
  assert.equal(cleanOrderNumber('C01234567890'), 'C01234567890')
  assert.equal(cleanOrderNumber('112-1234567-7654321'), '112-1234567-7654321')
})

test('about-to-ship and arrived emails for the same Target order merge to delivered', () => {
  const tgt = { fromName: 'Target', fromAddress: 'orders@oe.target.com' }
  const a = parseEmail(mk({ ...tgt, messageId: 'g1', subject: 'Items from order #912003456789ARE about to ship', date: new Date('2026-10-02') }))!
  const b = parseEmail(mk({ ...tgt, messageId: 'g2', subject: 'Items have arrived from order 912003456789', date: new Date('2026-10-04') }))!
  const orders = mergeIntoOrders([], [a, b])
  assert.equal(orders.length, 1)
  assert.equal(orders[0].status, 'delivered')
})

test('repair merges orders saved with glued numbers, keeps manual status', () => {
  const tgt = { fromName: 'Target', fromAddress: 'orders@oe.target.com' }
  const good = parseEmail(mk({ ...tgt, messageId: 'r2', subject: 'Items have arrived from order 912003456789', date: new Date('2026-10-04') }))!
  const bad = { ...parseEmail(mk({ ...tgt, messageId: 'r1', subject: 'Order #555000111222 confirmed', date: new Date('2026-10-02') }))!, orderNumber: '912003456789ARE' }
  const other = { ...parseEmail(mk({ ...tgt, messageId: 'r3', subject: 'Order #777000111222 confirmed' }))!, orderNumber: '777000111222ARE' }
  let orders = mergeIntoOrders([], [bad, good, other])
  assert.equal(orders.length, 3)
  orders = orders.map(o => (o.orderNumber === '777000111222ARE' ? { ...o, status: 'cancelled', manual: true } : o))
  const fixed = repairOrderNumbers(orders)
  assert.equal(fixed.length, 2)
  const t = fixed.find(o => o.orderNumber === '912003456789')!
  assert.equal(t.status, 'delivered')
  assert.equal(t.events.length, 2)
  const m = fixed.find(o => o.orderNumber === '777000111222')!
  assert.equal(m.status, 'cancelled'); assert.ok(m.manual)
  assert.equal(repairOrderNumbers(fixed), fixed) // no-op when clean
})

test('store confirmation with a generic subject and labeled order number in the body', () => {
  const pkc = { fromName: 'Pokémon Center', fromAddress: 'orders@em.pokemoncenter.com' }
  const p = parseEmail(mk({ ...pkc, subject: 'Thanks for shopping at Pokémon Center!', text: 'Order Number: P001234567\nOrder Total: $64.99' }))
  assert.equal(p?.status, 'ordered')
  assert.equal(p?.orderNumber, 'P001234567')
  assert.equal(p?.retailer, 'Pokémon Center')
  assert.equal(p?.total, '$64.99')
  assert.ok(SUBJECT_HINT.test('Thanks for shopping at Pokémon Center!'))
  assert.ok(SUBJECT_HINT.test('We got it! Confirmation #P001234567'))
})

test('explainEmail gives a reason for every verdict', () => {
  const none = explainEmail(mk({ subject: 'Big sale this weekend', text: 'Shop now' }))
  assert.equal(none.result, null); assert.match(none.reason, /No order number/)
  const promo = explainEmail(mk({ subject: 'New drop #12345 is live', text: 'Shop now' }))
  assert.equal(promo.result, null); assert.match(promo.reason, /marketing/)
  const skipped = explainEmail(mk({ subject: 'Hello from the team', text: 'Order Number: Z9988776 thank you for your order' }))
  assert.equal(skipped.passesPrefilter, false); assert.match(skipped.reason, /sync skips it/)
  const ok = explainEmail(mk({ subject: 'Your order #A77001 has shipped', text: '' }))
  assert.equal(ok.result?.status, 'shipped'); assert.match(ok.reason, /Recognised as shipped/)
})

test('target "about to ship" with tracking is shipped, and re-check fixes an existing order', () => {
  const tgt = { fromName: 'Target', fromAddress: 'orders@oe.target.com' }
  const conf = parseEmail(mk({ ...tgt, messageId: 'tc', date: new Date('2026-10-09'), subject: "Thanks for shopping with us! Here's your order #:0000999999999." }))!
  const ship = parseEmail(mk({ ...tgt, messageId: 'ts', date: new Date('2026-10-17'),
    subject: 'Get ready for something special! Items from order #0000999999999are about to ship.',
    text: 'Track your package. Tracking number: 9400111899223344556677' }))!
  assert.equal(conf.orderNumber, '0000999999999'); assert.equal(ship.orderNumber, '0000999999999')
  assert.equal(conf.status, 'ordered')
  assert.equal(ship.status, 'shipped')
  assert.equal(ship.carrier, 'USPS')
  // Order saved by the old parser: both events "ordered".
  const stale = mergeIntoOrders([], [conf, { ...ship, status: 'ordered' }])
  assert.equal(stale[0].status, 'ordered')
  // Next sync re-checks the same email with the new rules.
  const fixed = mergeIntoOrders(stale, [ship])
  assert.equal(fixed[0].status, 'shipped')
  assert.equal(fixed[0].events.length, 2)
  // Wording alone, no tracking number, is still shipped.
  assert.equal(detectStatus('Items from order #123456 are about to ship', ''), 'shipped')
  // Tracking number alone upgrades a vague update.
  assert.equal(parseEmail(mk({ subject: 'Update on your order #A55501', text: 'Your UPS tracking: 1Z999AA10123456784' }))?.status, 'shipped')
  // Confirmation without tracking stays ordered.
  assert.equal(parseEmail(mk({ subject: 'Thanks for your order #A55502', text: 'We will email tracking info when it ships.' }))?.status, 'ordered')
})

// Copied from a real Pokémon Center confirmation: four products, one each.
const PKC_ITEMS = `
Order Summary
Pokémon TCG: 30th Celebration Mini Tin – Pikachu (Night)
SKU #: 10-10465-172
Qty: 1
Price: $9.99
Pokémon TCG: 30th Celebration Mini Tin – Umbreon (Night)
SKU #: 10-10465-173
Qty: 1
Price: $9.99
Pokémon TCG: 30th Celebration Mini Tin – Pikachu (Day)
SKU #: 10-10465-167
Qty: 1
Price: $9.99
Pokémon TCG: 30th Celebration Mini Tin – Espeon (Day)
SKU #: 10-10465-168
Qty: 1
Price: $9.99`

test('item count: Pokémon Center sums Qty lines', () => {
  const pkc = { fromName: 'Pokémon Center', fromAddress: 'orders@em.pokemoncenter.com' }
  const p = parseEmail(mk({ ...pkc, subject: 'Thanks for shopping at Pokémon Center!', text: 'Order Number: P001234567\n' + PKC_ITEMS }))
  assert.equal(p?.items, 4)
  assert.equal(p?.orderNumber, 'P001234567') // SKU lines aren't mistaken for the order number
  assert.equal(extractItemCount('Pokémon Center', 'Qty: 2\nQty: 3'), 5)
})

test('item count: Target, other stores, and emails with no quantities', () => {
  assert.equal(extractItemCount('Target', 'Item A Qty: 2 $5.00 Item B Quantity: 1 $3.00'), 3)
  assert.equal(extractItemCount('Amazon', 'Qty: 2'), undefined)
  assert.equal(extractItemCount('Target', 'Your order is on its way'), undefined)
})

test('item count: order keeps the largest count across its emails', () => {
  const tgt = { fromName: 'Target', fromAddress: 'orders@oe.target.com' }
  const conf = parseEmail(mk({ ...tgt, messageId: 'i1', subject: 'Order #912003456789 confirmed', text: 'Qty: 2\nQty: 3', date: new Date('2026-10-01') }))!
  const part = parseEmail(mk({ ...tgt, messageId: 'i2', subject: 'Items from order #912003456789 have shipped', text: 'Qty: 2', date: new Date('2026-10-03') }))!
  const none = parseEmail(mk({ ...tgt, messageId: 'i3', subject: 'Items have arrived from order 912003456789', date: new Date('2026-10-05') }))!
  const [o] = mergeIntoOrders([], [conf, part, none])
  assert.equal(o.items, 5)
  assert.equal(mergeIntoOrders([], [part])[0].items, 2)
})

test('UPS: random link IDs starting with 1z are not tracking numbers', () => {
  // The bogus number from a real Pokémon Center shipping email, as it might appear in a link.
  const body = 'Track: https://click.em.pokemoncenter.com/?qs=1zsr8fsemcmnixv7ap&x=1\nTracking Number: 9400111899223344556677'
  assert.deepEqual(extractTracking(body), { trackingNumber: '9400111899223344556677', carrier: 'USPS' })
  assert.equal(extractTracking('ref 1ZSR8FSEMCMNIXV7AP'), null)
  // Right shape, wrong check digit.
  assert.equal(extractTracking('UPS 1Z999AA10123456785'), null)
  // A real one still works, even lower-case inside a UPS link.
  assert.deepEqual(extractTracking('https://www.ups.com/track?tracknum=1z999aa10123456784'), { trackingNumber: '1Z999AA10123456784', carrier: 'UPS' })
})

test('repairTracking clears bad saved UPS numbers and leaves good ones', () => {
  const tgt = { fromName: 'Target', fromAddress: 'orders@oe.target.com' }
  const good = parseEmail(mk({ ...tgt, messageId: 'u1', subject: 'Your order #A60001 has shipped', text: 'UPS 1Z999AA10123456784' }))!
  const other = parseEmail(mk({ ...tgt, messageId: 'u2', subject: 'Your order #A60002 has shipped' }))!
  let orders = mergeIntoOrders([], [good, other])
  assert.equal(repairTracking(orders), orders) // no-op when clean
  orders = orders.map(o => (o.orderNumber === 'A60002' ? { ...o, trackingNumber: '1ZSR8FSEMCMNIXV7AP', carrier: 'UPS' } : o))
  const fixed = repairTracking(orders)
  assert.equal(fixed.find(o => o.orderNumber === 'A60002')!.trackingNumber, undefined)
  assert.equal(fixed.find(o => o.orderNumber === 'A60001')!.trackingNumber, '1Z999AA10123456784')
})
