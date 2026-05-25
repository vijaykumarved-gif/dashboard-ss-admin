// ============ TOAST ============
function showToast(message, type = 'info') {
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = message;
    document.body.appendChild(t);
    setTimeout(() => {
        t.style.opacity = '0';
        t.style.transform = 'translateY(20px)';
        setTimeout(() => t.remove(), 300);
    }, 2500);
}

// ============ MODAL ============
function openModal(id) {
    document.getElementById(id)?.classList.add('active');
}
function closeModal(id) {
    document.getElementById(id)?.classList.remove('active');
}
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) {
        e.target.classList.remove('active');
    }
});

// ============ API ============
async function api(url, options = {}) {
    try {
        const res = await fetch(url, {
            headers: { 'Content-Type': 'application/json' },
            ...options
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Request failed');
        return data;
    } catch (e) {
        showToast(e.message, 'error');
        throw e;
    }
}

// ============ HELPERS ============
function formatINR(n) {
    return '₹' + (Number(n) || 0).toLocaleString('en-IN');
}

function formatDate(d) {
    if (!d) return '-';
    return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatDateTime(d) {
    if (!d) return '-';
    return new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function confirm2(msg) {
    return window.confirm(msg);
}

// ============ MOBILE SIDEBAR ============
function toggleSidebar() {
    document.querySelector('.sidebar')?.classList.toggle('open');
}

// ============ TAB SYSTEM ============
function switchTab(group, name) {
    document.querySelectorAll(`[data-tab-group="${group}"]`).forEach(el => {
        el.classList.toggle('active', el.dataset.tab === name);
    });
    document.querySelectorAll(`[data-tab-content="${group}"]`).forEach(el => {
        el.classList.toggle('active', el.dataset.content === name);
    });
}
