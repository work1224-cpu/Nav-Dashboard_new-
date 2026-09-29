const form = document.getElementById('loginForm');
const errorBox = document.getElementById('loginError');
const btn = document.getElementById('loginBtn');

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.add('show');
}

function hideError() {
  errorBox.classList.remove('show');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();

  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  if (!username || !password) {
    showError('Please enter both username and password.');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Signing in…';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Login failed');
    }

    // Redirect: admins go to dashboard too (they can also open /admin from there)
    window.location.href = '/';
  } catch (err) {
    showError(err.message);
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
});
