/*
 * Wait-page client: listens for provisioning status pushed over socket.io
 * and redirects to the container once it is ready.
 */
const socket = io();

socket.on('status', (status) => {
  if (status.state === 'ready') {
    location.replace(status.url);
    return;
  }
  if (status.state === 'error') {
    document.querySelector('.spinner').style.display = 'none';
    const msg = document.getElementById('msg');
    msg.className = 'error';
    msg.textContent = status.message || 'Something went wrong. Please try again later.';
  }
});
