require('dotenv').config();
require('dotenv').config({ path: '.env.local' });
const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Produits : les prix sont verifies ici, jamais cote client
const PRODUCTS = [
  { id: 1, name: 'Bracelet Chaine Classique', desc: 'Maille gourmette, argent', price: 2200, color: '#c9ced4' },
  { id: 2, name: 'Bracelet Dore Fin', desc: 'Acier dore, elegant', price: 2600, color: '#d4a73c' },
  { id: 3, name: 'Bracelet Noir Mat', desc: 'Style homme, fermoir securise', price: 2400, color: '#2b2b2e' },
  { id: 4, name: 'Bracelet Duo Couple', desc: 'Lot de 2, argent et or', price: 4200, color: '#b9a37a' },
];
const WILAYAS = "Adrar,Chlef,Laghouat,Oum El Bouaghi,Batna,Bejaia,Biskra,Bechar,Blida,Bouira,Tamanrasset,Tebessa,Tlemcen,Tiaret,Tizi Ouzou,Alger,Djelfa,Jijel,Setif,Saida,Skikda,Sidi Bel Abbes,Annaba,Guelma,Constantine,Medea,Mostaganem,M'Sila,Mascara,Ouargla,Oran,El Bayadh,Illizi,Bordj Bou Arreridj,Boumerdes,El Tarf,Tindouf,Tissemsilt,El Oued,Khenchela,Souk Ahras,Tipaza,Mila,Ain Defla,Naama,Ain Temouchent,Ghardaia,Relizane,Timimoun,Bordj Badji Mokhtar,Ouled Djellal,Beni Abbes,In Salah,In Guezzam,Touggourt,Djanet,El M'Ghair,El Meniaa".split(',');
const SOUTH = ['Adrar','Bechar','Tamanrasset','Tindouf','Illizi','Ouargla','El Oued','Ghardaia','Timimoun','Bordj Badji Mokhtar','Beni Abbes','In Salah','In Guezzam','Touggourt','Djanet',"El M'Ghair",'El Meniaa','Laghouat','Naama','El Bayadh'];
const shipping = (w) => (SOUTH.includes(w) ? 900 : w === 'Alger' ? 400 : 600);

pool.query(`CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL, phone TEXT NOT NULL, wilaya TEXT NOT NULL, address TEXT NOT NULL,
  product TEXT NOT NULL, qty INT NOT NULL, total INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'nouvelle',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`).then(() => console.log('Base prete')).catch((e) => console.error('Erreur base:', e.message));

app.get('/api/config', (req, res) => {
  res.json({ products: PRODUCTS, wilayas: WILAYAS.map((n) => ({ n, s: shipping(n) })) });
});

// Commande avec panier : plusieurs bracelets dans une seule commande
app.post('/api/orders', async (req, res) => {
  try {
    const { name, phone, wilaya, address, items } = req.body || {};
    if (!Array.isArray(items) || items.length < 1 || items.length > 10)
      return res.status(400).json({ error: 'Panier vide' });
    let sub = 0;
    let qtyTotal = 0;
    const parts = [];
    for (const it of items) {
      const p = PRODUCTS.find((x) => x.id === Number(it.productId));
      const q = Number(it.qty);
      if (!p || !Number.isInteger(q) || q < 1 || q > 5)
        return res.status(400).json({ error: 'Produit invalide' });
      sub += p.price * q;
      qtyTotal += q;
      parts.push(p.name + ' x' + q);
    }
    if (!WILAYAS.includes(wilaya)) return res.status(400).json({ error: 'Wilaya invalide' });
    const ph = String(phone || '').replace(/\s/g, '');
    if (!/^0[567]\d{8}$/.test(ph)) return res.status(400).json({ error: 'Telephone invalide' });
    const n = String(name || '').trim().slice(0, 80);
    const a = String(address || '').trim().slice(0, 200);
    if (n.length < 2 || a.length < 4) return res.status(400).json({ error: 'Nom ou adresse manquant' });
    const total = sub + shipping(wilaya);
    const r = await pool.query(
      'INSERT INTO orders(name,phone,wilaya,address,product,qty,total) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [n, ph, wilaya, a, parts.join(', ').slice(0, 500), qtyTotal, total]
    );
    res.json({ id: r.rows[0].id, total });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Admin protege par mot de passe (variable ADMIN_PASSWORD)
const admin = (req, res, next) => {
  if (!process.env.ADMIN_PASSWORD || req.get('x-admin-password') !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  next();
};
app.get('/api/admin/orders', admin, async (req, res) => {
  const r = await pool.query('SELECT * FROM orders ORDER BY id DESC LIMIT 500');
  res.json(r.rows);
});
app.patch('/api/admin/orders/:id', admin, async (req, res) => {
  const ok = ['nouvelle', 'confirmee', 'expediee', 'livree', 'annulee'];
  if (!ok.includes(req.body.status)) return res.status(400).json({ error: 'Statut invalide' });
  await pool.query('UPDATE orders SET status=$1 WHERE id=$2', [req.body.status, Number(req.params.id)]);
  res.json({ ok: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Lumia Bijoux sur http://localhost:' + port));