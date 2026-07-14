/**
 * Mock Bookstore API
 *
 * Serves a small, realistic REST API. Behavior can be toggled between
 * "before" (all healthy) and "after" (regressions injected) by writing
 * to state.json — no server restart needed, so Newman can hit the same
 * running instance for both runs.
 *
 * Endpoints:
 *   POST /login              -> auth, issues a fake token
 *   GET  /books               -> list books
 *   GET  /books/:id            -> get single book
 *   GET  /books/:id/availability -> stock check (logic-bug candidate)
 *   GET  /authors/:id          -> author lookup (flaky candidate)
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const STATE_PATH = path.join(__dirname, 'state.json');

function getState() {
  if (!fs.existsSync(STATE_PATH)) {
    return {
      mode: 'before',
      flakyCallCount: {}
    };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// Reset to healthy "before" state on boot.
saveState({ mode: 'before', flakyCallCount: {} });

const BOOKS = [
  { id: 1, title: 'The Pragmatic Programmer', price: 34.99, authorId: 1 },
  { id: 2, title: 'Clean Code', price: 29.99, authorId: 2 },
  { id: 3, title: 'Refactoring', price: 39.99, authorId: 3 }
];

const AUTHORS = [
  { id: 1, name: 'Andy Hunt' },
  { id: 2, name: 'Robert C. Martin' },
  { id: 3, name: 'Martin Fowler' }
];

// --- POST /login -----------------------------------------------------
// AFTER state: valid credentials that used to work now get rejected
// (simulates an auth regression, e.g. a changed token scheme or broken
// permission check).
app.post('/login', (req, res) => {
  const state = getState();
  const { username, password } = req.body || {};

  if (username !== 'demo' || password !== 'demo123') {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  if (state.mode === 'after') {
    // Regression: previously-valid demo credentials now rejected.
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  return res.status(200).json({ token: 'fake-jwt-token-abc123' });
});

// --- GET /books --------------------------------------------------------
// AFTER state: schema change — "price" renamed to "cost".
app.get('/books', (req, res) => {
  const state = getState();

  if (state.mode === 'after') {
    const renamed = BOOKS.map((b) => ({
      id: b.id,
      title: b.title,
      cost: b.price, // schema change: price -> cost
      authorId: b.authorId
    }));
    return res.status(200).json(renamed);
  }

  return res.status(200).json(BOOKS);
});

// --- GET /books/:id ------------------------------------------------
// AFTER state: endpoint down for a specific id (simulates a broken route
// or upstream dependency failure).
app.get('/books/:id', (req, res) => {
  const state = getState();
  const id = parseInt(req.params.id, 10);
  const book = BOOKS.find((b) => b.id === id);

  if (!book) {
    return res.status(404).json({ error: 'Book not found' });
  }

  if (state.mode === 'after' && id === 2) {
    // Regression: this endpoint now 500s for book id 2.
    return res.status(500).json({ error: 'Internal server error' });
  }

  return res.status(200).json(book);
});

// --- GET /books/:id/availability -------------------------------------
// AFTER state: logic bug — always returns inStock:true regardless of
// actual stock, a silent correctness regression (no error code change).
app.get('/books/:id/availability', (req, res) => {
  const state = getState();
  const id = parseInt(req.params.id, 10);
  const book = BOOKS.find((b) => b.id === id);

  if (!book) {
    return res.status(404).json({ error: 'Book not found' });
  }

  const actualStock = id === 3 ? 0 : 5; // book 3 is genuinely out of stock

  if (state.mode === 'after') {
    // Regression: logic bug always reports inStock true.
    return res.status(200).json({ id, inStock: true, quantity: actualStock });
  }

  return res.status(200).json({ id, inStock: actualStock > 0, quantity: actualStock });
});

// --- GET /authors/:id --------------------------------------------------
// AFTER state: flaky — fails intermittently (every other call) rather
// than consistently, simulating a race condition or unstable dependency.
app.get('/authors/:id', (req, res) => {
  const state = getState();
  const id = parseInt(req.params.id, 10);
  const author = AUTHORS.find((a) => a.id === id);

  if (!author) {
    return res.status(404).json({ error: 'Author not found' });
  }

  if (state.mode === 'after') {
    const key = `author_${id}`;
    const count = (state.flakyCallCount[key] || 0) + 1;
    state.flakyCallCount[key] = count;
    saveState(state);

    if (count % 2 === 0) {
      return res.status(503).json({ error: 'Service temporarily unavailable' });
    }
  }

  return res.status(200).json(author);
});

// --- Health check -------------------------------------------------------
app.get('/health', (req, res) => res.status(200).json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Mock Bookstore API listening on port ${PORT}`);
});
