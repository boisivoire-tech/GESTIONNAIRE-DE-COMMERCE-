from __future__ import annotations

import csv
import hmac
import io
import json
import os
import secrets
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from functools import wraps

from flask import Flask, jsonify, redirect, render_template, request, session, url_for
from flask_sqlalchemy import SQLAlchemy
from flask_wtf.csrf import CSRFError, CSRFProtect, generate_csrf
from sqlalchemy import text
from werkzeug.middleware.proxy_fix import ProxyFix


APP_ENV = os.environ.get("APP_ENV", "development").lower()
ADMIN_USER = os.environ.get("ADMIN_USER", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD")
if APP_ENV == "production" and not ADMIN_PASSWORD:
    raise RuntimeError("Définissez ADMIN_PASSWORD dans les variables secrètes de l'hébergeur.")
if not ADMIN_PASSWORD:
    ADMIN_PASSWORD = "change-me-local-only"
SECRET_KEY = os.environ.get("SECRET_KEY")
if APP_ENV == "production" and not SECRET_KEY:
    raise RuntimeError("Définissez SECRET_KEY dans les variables secrètes de l'hébergeur.")

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///commerce-online.sqlite3")
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+psycopg://", 1)
elif DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+psycopg://", 1)

app = Flask(__name__, template_folder="templates", static_folder="static")
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
app.config.update(
    SECRET_KEY=SECRET_KEY or secrets.token_hex(32),
    SQLALCHEMY_DATABASE_URI=DATABASE_URL,
    SQLALCHEMY_TRACK_MODIFICATIONS=False,
    SQLALCHEMY_ENGINE_OPTIONS={"pool_pre_ping": True},
    MAX_CONTENT_LENGTH=32 * 1024 * 1024,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SECURE=(APP_ENV == "production"),
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=12),
    WTF_CSRF_TIME_LIMIT=timedelta(hours=12),
)
db = SQLAlchemy(app)
csrf = CSRFProtect(app)
LOGIN_FAILURES: dict[str, list[float]] = {}
SUPPORTED_CURRENCIES = {"EUR", "USD", "CAD", "CHF", "XOF"}


class Setting(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    store_name = db.Column(db.String(60), nullable=False, default="Ma boutique")
    currency = db.Column(db.String(3), nullable=False, default="EUR")


class Product(db.Model):
    id = db.Column(db.String(40), primary_key=True)
    name = db.Column(db.String(80), nullable=False)
    sku = db.Column(db.String(40), nullable=False, default="")
    category = db.Column(db.String(50), nullable=False, default="Général")
    stock = db.Column(db.Integer, nullable=False, default=0)
    price = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    cost = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    low_stock = db.Column(db.Integer, nullable=False, default=3)
    active = db.Column(db.Boolean, nullable=False, default=True)


class Customer(db.Model):
    id = db.Column(db.String(40), primary_key=True)
    name = db.Column(db.String(80), nullable=False)
    phone = db.Column(db.String(40), nullable=False, default="")
    email = db.Column(db.String(120), nullable=False, default="")
    note = db.Column(db.String(160), nullable=False, default="")
    active = db.Column(db.Boolean, nullable=False, default=True)


class Sale(db.Model):
    id = db.Column(db.String(40), primary_key=True)
    number = db.Column(db.String(40), nullable=False, unique=True)
    date = db.Column(db.String(10), nullable=False)
    customer_id = db.Column(db.String(40), nullable=True)
    customer_name = db.Column(db.String(80), nullable=False, default="Client de passage")
    total = db.Column(db.Numeric(12, 2), nullable=False)
    status = db.Column(db.String(12), nullable=False, default="completed")
    items = db.relationship("SaleItem", backref="sale", cascade="all, delete-orphan", lazy=True)


class SaleItem(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    sale_id = db.Column(db.String(40), db.ForeignKey("sale.id"), nullable=False)
    product_id = db.Column(db.String(40), nullable=False)
    name = db.Column(db.String(80), nullable=False)
    sku = db.Column(db.String(40), nullable=False, default="")
    quantity = db.Column(db.Integer, nullable=False)
    unit_price = db.Column(db.Numeric(12, 2), nullable=False)
    unit_cost = db.Column(db.Numeric(12, 2), nullable=False, default=0)


def clean_text(value, label: str, max_length: int, required: bool = True) -> str:
    value = str(value or "").strip()
    if required and not value:
        raise ValueError(f"Le champ « {label} » est obligatoire.")
    if len(value) > max_length:
        raise ValueError(f"Le champ « {label} » est trop long.")
    return value


def valid_money(value, label: str, allow_zero: bool = True) -> Decimal:
    try:
        amount = Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except (InvalidOperation, TypeError, ValueError):
        raise ValueError(f"{label} doit être un nombre.")
    if not amount.is_finite() or amount < 0 or (not allow_zero and amount == 0):
        raise ValueError(f"{label} doit être {('supérieur à zéro' if not allow_zero else 'positif ou égal à zéro')}.")
    if amount > Decimal("999999999.99"):
        raise ValueError(f"{label} est trop élevé.")
    return amount


def valid_integer(value, label: str, minimum: int = 0) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{label} doit être un nombre entier.")
    if str(value).strip() not in {str(number), f"{number}.0"}:
        raise ValueError(f"{label} doit être un nombre entier.")
    if number < minimum or number > 999_999_999:
        raise ValueError(f"{label} doit être supérieur ou égal à {minimum}.")
    return number


def as_float(value) -> float:
    return float(value or 0)


def product_json(product: Product) -> dict:
    return {"id": product.id, "name": product.name, "sku": product.sku, "category": product.category,
            "stock": product.stock, "price": as_float(product.price), "cost": as_float(product.cost),
            "low_stock": product.low_stock, "active": product.active}


def customer_json(customer: Customer) -> dict:
    return {"id": customer.id, "name": customer.name, "phone": customer.phone, "email": customer.email,
            "note": customer.note, "active": customer.active}


def sale_json(sale: Sale) -> dict:
    return {"id": sale.id, "number": sale.number, "date": sale.date, "customer_id": sale.customer_id,
            "customer_name": sale.customer_name, "total": as_float(sale.total), "status": sale.status,
            "items": [{"product_id": item.product_id, "name": item.name, "sku": item.sku,
                       "quantity": item.quantity, "unit_price": as_float(item.unit_price),
                       "unit_cost": as_float(item.unit_cost)} for item in sale.items]}


def setting_row() -> Setting:
    setting = db.session.get(Setting, 1)
    if setting is None:
        setting = Setting(id=1, store_name="Ma boutique", currency="EUR")
        db.session.add(setting)
        db.session.commit()
    return setting


def json_payload() -> dict:
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ValueError("Les données reçues ne sont pas valides.")
    return data


def api_auth_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("authenticated"):
            return jsonify(error="Votre session a expiré. Connectez-vous à nouveau."), 401
        return view(*args, **kwargs)
    return wrapped


def login_limiter_key() -> str:
    return request.remote_addr or "unknown"


def login_is_limited() -> bool:
    now = time.time()
    key = login_limiter_key()
    LOGIN_FAILURES[key] = [attempt for attempt in LOGIN_FAILURES.get(key, []) if now - attempt < 900]
    return len(LOGIN_FAILURES[key]) >= 8


def record_login_failure() -> None:
    LOGIN_FAILURES.setdefault(login_limiter_key(), []).append(time.time())


@app.before_request
def protect_api():
    if request.path.startswith("/api/") and not session.get("authenticated"):
        return jsonify(error="Votre session a expiré. Connectez-vous à nouveau."), 401


@app.after_request
def add_security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Cache-Control"] = "no-store"
    response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
    return response


@app.errorhandler(CSRFError)
def handle_csrf_error(error):
    if request.path.startswith("/api/"):
        return jsonify(error="La page a expiré. Actualisez-la puis réessayez."), 400
    return render_template("login.html", csrf_token=generate_csrf(), error="La page a expiré. Réessayez."), 400


@app.route("/health")
def health():
    db.session.execute(text("SELECT 1"))
    return {"ok": True}


@app.route("/login", methods=["GET", "POST"])
def login():
    if session.get("authenticated"):
        return redirect(url_for("home"))
    error = None
    if request.method == "POST":
        if login_is_limited():
            error = "Trop de tentatives. Réessayez dans 15 minutes."
        else:
            username = request.form.get("username", "")
            password = request.form.get("password", "")
            user_ok = hmac.compare_digest(username.encode("utf-8"), ADMIN_USER.encode("utf-8"))
            password_ok = hmac.compare_digest(password.encode("utf-8"), ADMIN_PASSWORD.encode("utf-8"))
            if user_ok and password_ok:
                LOGIN_FAILURES.pop(login_limiter_key(), None)
                session.clear()
                session["authenticated"] = True
                session.permanent = True
                return redirect(url_for("home"))
            record_login_failure()
            error = "Identifiant ou mot de passe incorrect."
    return render_template("login.html", csrf_token=generate_csrf(), error=error)


@app.post("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/")
def home():
    if not session.get("authenticated"):
        return redirect(url_for("login"))
    setting = setting_row()
    return render_template("index.html", csrf_token=generate_csrf(), store_name=setting.store_name)


@app.get("/api/data")
@api_auth_required
def get_data():
    setting = setting_row()
    return jsonify({
        "store_name": setting.store_name,
        "currency": setting.currency,
        "products": [product_json(item) for item in Product.query.order_by(Product.name).all()],
        "customers": [customer_json(item) for item in Customer.query.order_by(Customer.name).all()],
        "sales": [sale_json(item) for item in Sale.query.order_by(Sale.date.desc(), Sale.number.desc()).all()],
    })


@app.post("/api/products")
@api_auth_required
def save_product():
    payload = json_payload()
    product_id = clean_text(payload.get("id"), "identifiant", 40, required=False) or uuid.uuid4().hex
    product = db.session.get(Product, product_id)
    is_new = product is None
    if is_new:
        product = Product(id=product_id)
    product.name = clean_text(payload.get("name"), "nom du produit", 80)
    product.sku = clean_text(payload.get("sku"), "référence", 40, required=False)
    product.category = clean_text(payload.get("category"), "catégorie", 50, required=False) or "Général"
    product.stock = valid_integer(payload.get("stock", 0), "Le stock")
    product.low_stock = valid_integer(payload.get("low_stock", 3), "Le seuil d'alerte")
    product.price = valid_money(payload.get("price", 0), "Le prix de vente")
    product.cost = valid_money(payload.get("cost", 0), "Le coût d'achat")
    if is_new:
        product.active = True
        db.session.add(product)
    db.session.commit()
    return jsonify(product=product_json(product))


@app.delete("/api/products/<product_id>")
@api_auth_required
def archive_product(product_id):
    product = db.session.get(Product, product_id)
    if product is None:
        return jsonify(error="Ce produit est introuvable."), 404
    product.active = False
    db.session.commit()
    return jsonify(ok=True)


@app.post("/api/customers")
@api_auth_required
def save_customer():
    payload = json_payload()
    customer_id = clean_text(payload.get("id"), "identifiant", 40, required=False) or uuid.uuid4().hex
    customer = db.session.get(Customer, customer_id)
    is_new = customer is None
    if is_new:
        customer = Customer(id=customer_id)
    customer.name = clean_text(payload.get("name"), "nom du client", 80)
    customer.phone = clean_text(payload.get("phone"), "téléphone", 40, required=False)
    customer.email = clean_text(payload.get("email"), "courriel", 120, required=False)
    customer.note = clean_text(payload.get("note"), "note", 160, required=False)
    if is_new:
        customer.active = True
        db.session.add(customer)
    db.session.commit()
    return jsonify(customer=customer_json(customer))


@app.delete("/api/customers/<customer_id>")
@api_auth_required
def archive_customer(customer_id):
    customer = db.session.get(Customer, customer_id)
    if customer is None:
        return jsonify(error="Ce client est introuvable."), 404
    customer.active = False
    db.session.commit()
    return jsonify(ok=True)


@app.post("/api/sales")
@api_auth_required
def create_sale():
    payload = json_payload()
    requested_items = payload.get("items")
    if not isinstance(requested_items, list) or not requested_items:
        raise ValueError("Ajoutez au moins un produit à la vente.")
    customer_id = clean_text(payload.get("customer_id"), "client", 40, required=False)
    customer = db.session.get(Customer, customer_id) if customer_id else None
    if customer is not None and not customer.active:
        customer = None
    quantities: dict[str, int] = {}
    for item in requested_items:
        if not isinstance(item, dict):
            raise ValueError("Une ligne de vente est invalide.")
        product_id = clean_text(item.get("product_id"), "produit", 40)
        quantity = valid_integer(item.get("quantity", 0), "La quantité", minimum=1)
        quantities[product_id] = quantities.get(product_id, 0) + quantity
    product_map = {item.id: item for item in Product.query.filter_by(active=True).filter(Product.id.in_(quantities.keys())).all()}
    sale_lines = []
    total = Decimal("0.00")
    for product_id, quantity in quantities.items():
        product = product_map.get(product_id)
        if product is None:
            raise ValueError("Un produit sélectionné n'est plus disponible.")
        if product.stock < quantity:
            raise ValueError(f"Stock insuffisant pour « {product.name} ». Il en reste {product.stock}.")
        line_total = product.price * quantity
        total += line_total
        sale_lines.append((product, quantity, line_total))
    now = date.today()
    sale_id = uuid.uuid4().hex
    sale = Sale(id=sale_id, number=f"V-{now:%Y%m%d}-{sale_id[:6].upper()}", date=now.isoformat(),
                customer_id=customer.id if customer else None,
                customer_name=customer.name if customer else "Client de passage",
                total=total.quantize(Decimal("0.01")), status="completed")
    try:
        db.session.add(sale)
        for product, quantity, _ in sale_lines:
            product.stock -= quantity
            db.session.add(SaleItem(sale_id=sale.id, product_id=product.id, name=product.name, sku=product.sku,
                                    quantity=quantity, unit_price=product.price, unit_cost=product.cost))
        db.session.commit()
    except Exception:
        db.session.rollback()
        raise
    return jsonify(sale=sale_json(sale)), 201


@app.post("/api/sales/<sale_id>/cancel")
@api_auth_required
def cancel_sale(sale_id):
    sale = db.session.get(Sale, sale_id)
    if sale is None:
        return jsonify(error="Cette vente est introuvable."), 404
    if sale.status == "cancelled":
        return jsonify(error="Cette vente est déjà annulée."), 400
    try:
        for item in sale.items:
            product = db.session.get(Product, item.product_id)
            if product is not None:
                product.stock += item.quantity
        sale.status = "cancelled"
        db.session.commit()
    except Exception:
        db.session.rollback()
        raise
    return jsonify(sale=sale_json(sale))


@app.post("/api/settings")
@api_auth_required
def save_settings():
    payload = json_payload()
    store_name = clean_text(payload.get("store_name"), "nom du commerce", 60)
    currency = payload.get("currency")
    if currency not in SUPPORTED_CURRENCIES:
        raise ValueError("Choisissez une devise disponible dans la liste.")
    setting = setting_row()
    setting.store_name = store_name
    setting.currency = currency
    db.session.commit()
    return jsonify(store_name=store_name, currency=currency)


@app.get("/api/backup.json")
@api_auth_required
def download_backup():
    setting = setting_row()
    data = {"store_name": setting.store_name, "currency": setting.currency,
            "products": [product_json(item) for item in Product.query.all()],
            "customers": [customer_json(item) for item in Customer.query.all()],
            "sales": [sale_json(item) for item in Sale.query.order_by(Sale.date).all()]}
    body = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
    return app.response_class(body, mimetype="application/json", headers={"Content-Disposition": "attachment; filename=sauvegarde-commerce.json"})


def safe_csv(value) -> str:
    value = str(value or "")
    return "'" + value if value.startswith(("=", "+", "-", "@")) else value


@app.get("/api/export/<kind>.csv")
@api_auth_required
def export_csv(kind):
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    setting = setting_row()
    if kind == "products":
        writer.writerow(["Référence", "Produit", "Catégorie", "Stock", "Prix de vente", "Coût", "Seuil bas", "État"])
        for item in Product.query.order_by(Product.name).all():
            writer.writerow([safe_csv(item.sku), safe_csv(item.name), safe_csv(item.category), item.stock, item.price, item.cost, item.low_stock, "Actif" if item.active else "Archivé"])
        filename = "produits-stock.csv"
    elif kind == "customers":
        writer.writerow(["Nom", "Téléphone", "Courriel", "Note"])
        for item in Customer.query.filter_by(active=True).order_by(Customer.name).all():
            writer.writerow([safe_csv(item.name), safe_csv(item.phone), safe_csv(item.email), safe_csv(item.note)])
        filename = "clients.csv"
    elif kind == "sales":
        writer.writerow(["N° vente", "Date", "État", "Client", "Produit", "Quantité", "Prix unitaire", "Total de ligne", "Devise"])
        for sale in Sale.query.order_by(Sale.date).all():
            for item in sale.items:
                line_total = item.unit_price * item.quantity
                writer.writerow([sale.number, sale.date, "Annulée" if sale.status == "cancelled" else "Payée", safe_csv(sale.customer_name), safe_csv(item.name), item.quantity, item.unit_price, line_total, setting.currency])
        filename = "ventes.csv"
    else:
        return jsonify(error="Type d’export inconnu."), 404
    body = ("\ufeff" + output.getvalue()).encode("utf-8")
    return app.response_class(body, mimetype="text/csv; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@app.post("/api/backup")
@api_auth_required
def restore_backup():
    payload = json_payload()
    products = payload.get("products")
    customers = payload.get("customers")
    sales = payload.get("sales")
    if not all(isinstance(value, list) for value in (products, customers, sales)):
        raise ValueError("Le fichier de sauvegarde ne contient pas les données attendues.")
    if len(products) > 10000 or len(customers) > 10000 or len(sales) > 100000:
        raise ValueError("Cette sauvegarde dépasse les limites prises en charge.")
    currency = payload.get("currency", "EUR")
    if currency not in SUPPORTED_CURRENCIES:
        raise ValueError("La devise de la sauvegarde n’est pas reconnue.")
    store_name = clean_text(payload.get("store_name", "Ma boutique"), "nom du commerce", 60)
    try:
        SaleItem.query.delete()
        Sale.query.delete()
        Product.query.delete()
        Customer.query.delete()
        for raw in products:
            if not isinstance(raw, dict):
                raise ValueError("Un produit de la sauvegarde est invalide.")
            db.session.add(Product(id=clean_text(raw.get("id"), "identifiant", 40),
                name=clean_text(raw.get("name"), "nom du produit", 80), sku=clean_text(raw.get("sku"), "référence", 40, False),
                category=clean_text(raw.get("category"), "catégorie", 50, False) or "Général", stock=valid_integer(raw.get("stock", 0), "Le stock"),
                price=valid_money(raw.get("price", 0), "Le prix de vente"), cost=valid_money(raw.get("cost", 0), "Le coût d'achat"),
                low_stock=valid_integer(raw.get("low_stock", 3), "Le seuil d'alerte"), active=bool(raw.get("active", True))))
        for raw in customers:
            if not isinstance(raw, dict):
                raise ValueError("Un client de la sauvegarde est invalide.")
            db.session.add(Customer(id=clean_text(raw.get("id"), "identifiant", 40), name=clean_text(raw.get("name"), "nom du client", 80),
                phone=clean_text(raw.get("phone"), "téléphone", 40, False), email=clean_text(raw.get("email"), "courriel", 120, False),
                note=clean_text(raw.get("note"), "note", 160, False), active=bool(raw.get("active", True))))
        for raw in sales:
            if not isinstance(raw, dict):
                raise ValueError("Une vente de la sauvegarde est invalide.")
            sale_id = clean_text(raw.get("id"), "identifiant de vente", 40)
            sale = Sale(id=sale_id, number=clean_text(raw.get("number"), "numéro de vente", 40),
                date=clean_text(raw.get("date"), "date", 10), customer_id=clean_text(raw.get("customer_id"), "client", 40, False) or None,
                customer_name=clean_text(raw.get("customer_name"), "nom du client", 80, False) or "Client de passage",
                total=valid_money(raw.get("total", 0), "Le total"), status="cancelled" if raw.get("status") == "cancelled" else "completed")
            db.session.add(sale)
            for item in raw.get("items", []):
                if not isinstance(item, dict):
                    raise ValueError("Une ligne de vente de la sauvegarde est invalide.")
                db.session.add(SaleItem(sale_id=sale_id, product_id=clean_text(item.get("product_id"), "produit", 40),
                    name=clean_text(item.get("name"), "nom du produit", 80), sku=clean_text(item.get("sku"), "référence", 40, False),
                    quantity=valid_integer(item.get("quantity", 0), "La quantité", 1), unit_price=valid_money(item.get("unit_price", 0), "Le prix"),
                    unit_cost=valid_money(item.get("unit_cost", 0), "Le coût")))
        setting = db.session.get(Setting, 1) or Setting(id=1)
        setting.store_name = store_name
        setting.currency = currency
        db.session.add(setting)
        db.session.commit()
    except Exception:
        db.session.rollback()
        raise
    return jsonify(ok=True)


@app.errorhandler(ValueError)
def handle_value_error(error):
    if request.path.startswith("/api/"):
        return jsonify(error=str(error)), 400
    return str(error), 400


with app.app_context():
    db.create_all()
    setting_row()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    host = "0.0.0.0" if APP_ENV == "production" else "127.0.0.1"
    app.run(host=host, port=port, debug=False)
