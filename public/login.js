const form = document.getElementById('form');
const input = document.getElementById('password');
const button = document.getElementById('submit');
const error = document.getElementById('error');

function showError(message) {
  error.textContent = message;
  error.hidden = false;
  input.select();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.hidden = true;
  button.disabled = true;
  button.textContent = 'Checking…';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: input.value }),
    });
    if (res.ok) {
      window.location.replace('/');
      return;
    }
    const data = await res.json().catch(() => ({}));
    showError(data.error || 'Login failed');
  } catch {
    showError('Server unreachable');
  }
  button.disabled = false;
  button.textContent = 'Unlock';
});
