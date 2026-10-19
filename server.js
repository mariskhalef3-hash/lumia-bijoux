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

const WILAYAS = "Adrar,Chlef,Laghouat,Oum El Bouaghi,Batna,Bejaia,Biskra,Bechar,Blida,Bouira,Tamanrasset,Tebessa,Tlemcen,Tiaret,Tizi Ouzou,Alger,Djelfa,Jijel,Setif,Saida,Skikda,Sidi Bel Abbes,Annaba,Guelma,Constantine,Medea,Mostaganem,M'Sila,Mascara,Ouargla,Oran,El Bayadh,Illizi,Bordj Bou Arreridj,Boumerdes,El Tarf,Tindouf,Tissemsilt,El Oued,Khenchela,Souk Ahras,Tipaza,Mila,Ain Defla,Naama,Ain Temouchent,Ghardaia,Relizane,Timimoun,Bordj Badji Mokhtar,Ouled Djellal,Beni Abbes,In Salah,In Guezzam,Touggourt,Djanet,El M'Ghair,El Meniaa".split(',');
const SOUTH = ['Adrar','Bechar','Tamanrasset','Tindouf','Illizi','Ouargla','El Oued','Ghardaia','Timimoun','Bordj Badji Mokhtar','Beni Abbes','In Salah','In Guezzam','Touggourt','Djanet',"El M'Ghair",'El Meniaa','Laghouat','Naama','El Bayadh'];
const shipping = (w) => (SOUTH.includes(w) ? 900 : w === 'Alger' ? 400 : 600);
const MAX_PHOTOS = 8;

// Produits de depart, ajoutes une seule fois a la creation de la table
const SEED = [
  { name: 'Bracelet Chaine Classique', desc: 'Maille gourmette, argent', price: 2200, color: '#c9ced4' },
  { name: 'Bracelet Dore Fin', desc: 'Acier dore, elegant', price: 2600, color: '#d4a73c' },
  { name: 'Bracelet Noir Mat', desc: 'Style homme, fermoir securise', price: 2400, color: '#2b2b2e' },
  { name: 'Bracelet Duo Couple', desc: 'Lot de 2, argent et or', price: 4200, color: '#b9a37a' },
];

async function init() {
  await pool.query(`CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL, phone TEXT NOT NULL, wilaya TEXT NOT NULL, address TEXT NOT NULL,
    product TEXT NOT NULL, qty INT NOT NULL, total INT NOT NULL,
    status TEXT NOT NULL DEFAULT 'nouvelle',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const existed = (await pool.query("SELECT to_regclass('public.products') AS t")).rows[0].t !== null;
  await pool.query(`CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price INT NOT NULL,
    color TEXT NOT NULL DEFAULT '#c9ced4',
    image BYTEA,
    img_v BIGINT NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT true,
    sort INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  if (!existed) {
    for (let i = 0; i < SEED.length; i++) {
      const p = SEED[i];
      await pool.query(
        'INSERT INTO products(name,description,price,color,sort) VALUES($1,$2,$3,$4,$5)',
        [p.name, p.desc, p.price, p.color, i]
      );
    }
  }
  // Photos : plusieurs par produit
  await pool.query(`CREATE TABLE IF NOT EXISTS product_images (
    id SERIAL PRIMARY KEY,
    product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    image BYTEA NOT NULL,
    sort INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS product_images_product_idx ON product_images(product_id)');
  // Reprise des anciennes photos (une seule par produit) dans la nouvelle table
  await pool.query(`INSERT INTO product_images(product_id,image)
    SELECT p.id, p.image FROM products p
    WHERE p.image IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM product_images i WHERE i.product_id = p.id)`);
  await pool.query('UPDATE products SET image = NULL WHERE image IS NOT NULL');
  console.log('Base prete');
}
init().catch((e) => console.error('Erreur base:', e.message));

const IMGS_SQL = `COALESCE((SELECT json_agg(i.id ORDER BY i.sort, i.id) FROM product_images i WHERE i.product_id = p.id), '[]'::json)`;
const imgUrl = (id) => '/api/images/' + id;

// ---------- Cote client ----------
app.get('/api/config', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.id, p.name, p.description, p.price, p.color, ${IMGS_SQL} AS imgs
       FROM products p WHERE p.active ORDER BY p.sort, p.id`
    );
    res.json({
      products: r.rows.map((x) => {
        const imgs = (x.imgs || []).map(imgUrl);
        return { id: x.id, name: x.name, desc: x.description, price: x.price, color: x.color, img: imgs[0] || null, imgs };
      }),
      wilayas: WILAYAS.map((n) => ({ n, s: shipping(n) })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/images/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.sendStatus(404);
  const r = await pool.query('SELECT image FROM product_images WHERE id=$1', [id]);
  if (!r.rows[0]) return res.sendStatus(404);
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(r.rows[0].image);
});

// Commande avec panier : les prix sont lus dans la base, jamais cote client
app.post('/api/orders', async (req, res) => {
  try {
    const { name, phone, wilaya, address, items } = req.body || {};
    if (!Array.isArray(items) || items.length < 1 || items.length > 10)
      return res.status(400).json({ error: 'Panier vide' });
    const ids = items.map((it) => Number(it.productId)).filter((n) => Number.isInteger(n));
    const pr = await pool.query('SELECT id,name,price FROM products WHERE active AND id = ANY($1::int[])', [ids]);
    const byId = new Map(pr.rows.map((p) => [p.id, p]));
    let sub = 0;
    let qtyTotal = 0;
    const parts = [];
    for (const it of items) {
      const p = byId.get(Number(it.productId));
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

// ---------- Admin protege par mot de passe (variable ADMIN_PASSWORD) ----------
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

// Produits : liste complete (y compris masques), avec toutes les photos
app.get('/api/admin/products', admin, async (req, res) => {
  const r = await pool.query(
    `SELECT p.id, p.name, p.description, p.price, p.active, ${IMGS_SQL} AS imgs
     FROM products p ORDER BY p.sort, p.id`
  );
  res.json(
    r.rows.map((x) => {
      const ids = x.imgs || [];
      return {
        id: x.id, name: x.name, description: x.description, price: x.price, active: x.active,
        imgs: ids.map((i) => ({ id: i, url: imgUrl(i) })),
        img: ids.length ? imgUrl(ids[0]) : null,
      };
    })
  );
});

function cleanProduct(b) {
  const name = String(b.name || '').trim().slice(0, 80);
  const description = String(b.description || '').trim().slice(0, 200);
  const price = Number(b.price);
  if (name.length < 2) return { error: 'Nom trop court' };
  if (!Number.isInteger(price) || price < 100 || price > 1000000) return { error: 'Prix invalide' };
  return { name, description, price };
}

app.post('/api/admin/products', admin, async (req, res) => {
  const c = cleanProduct(req.body || {});
  if (c.error) return res.status(400).json({ error: c.error });
  const r = await pool.query(
    'INSERT INTO products(name,description,price,sort) VALUES($1,$2,$3,(SELECT COALESCE(MAX(sort),0)+1 FROM products)) RETURNING id',
    [c.name, c.description, c.price]
  );
  res.json({ id: r.rows[0].id });
});

app.patch('/api/admin/products/:id', admin, async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  if (typeof b.active === 'boolean' && b.name === undefined) {
    await pool.query('UPDATE products SET active=$1 WHERE id=$2', [b.active, id]);
    return res.json({ ok: true });
  }
  const c = cleanProduct(b);
  if (c.error) return res.status(400).json({ error: c.error });
  await pool.query('UPDATE products SET name=$1,description=$2,price=$3 WHERE id=$4', [c.name, c.description, c.price, id]);
  res.json({ ok: true });
});

app.delete('/api/admin/products/:id', admin, async (req, res) => {
  await pool.query('DELETE FROM products WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
});

// Photos : l'admin envoie une image JPEG a la fois (reduite par le navigateur avant l'envoi)
app.post('/api/admin/products/:id/images', admin, express.raw({ type: 'image/jpeg', limit: '3mb' }), async (req, res) => {
  const pid = Number(req.params.id);
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8)
    return res.status(400).json({ error: 'Image invalide (JPEG attendu)' });
  const c = await pool.query(
    'SELECT EXISTS(SELECT 1 FROM products WHERE id=$1) AS ok, (SELECT count(*)::int FROM product_images WHERE product_id=$1) AS n',
    [pid]
  );
  if (!c.rows[0].ok) return res.status(404).json({ error: 'Produit introuvable' });
  if (c.rows[0].n >= MAX_PHOTOS) return res.status(400).json({ error: MAX_PHOTOS + ' photos maximum par produit' });
  const r = await pool.query(
    'INSERT INTO product_images(product_id,image,sort) VALUES($1,$2,(SELECT COALESCE(MAX(sort),0)+1 FROM product_images WHERE product_id=$1)) RETURNING id',
    [pid, buf]
  );
  res.json({ id: r.rows[0].id });
});

app.delete('/api/admin/images/:id', admin, async (req, res) => {
  await pool.query('DELETE FROM product_images WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
});

// Mettre une photo en premiere position (photo principale)
app.patch('/api/admin/images/:id', admin, async (req, res) => {
  await pool.query(
    `UPDATE product_images SET sort = (
       SELECT COALESCE(MIN(sort),0) - 1 FROM product_images
       WHERE product_id = (SELECT product_id FROM product_images WHERE id = $1)
     ) WHERE id = $1`,
    [Number(req.params.id)]
  );
  res.json({ ok: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Lumia Bijoux sur http://localhost:' + port));