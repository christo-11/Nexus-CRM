import os
from datetime import datetime, timezone
from pathlib import Path

import click
from flask import Flask, jsonify
from flask_cors import CORS
from flask_jwt_extended import JWTManager
from flask_migrate import Migrate
from flask_socketio import SocketIO
from sqlalchemy import text
from sqlalchemy.engine import make_url
from werkzeug.middleware.proxy_fix import ProxyFix

from .extensions import db, limiter, mail

jwt = JWTManager()
migrate = Migrate()
socketio = SocketIO()


def normalize_database_url(database_url):
    url = make_url(database_url)
    if url.drivername in {"postgres", "postgresql"}:
        url = url.set(drivername="postgresql+psycopg")
    if url.drivername == "postgresql+psycopg":
        query = dict(url.query)
        query.setdefault("sslmode", "require")
        url = url.set(query=query)
    return url.render_as_string(hide_password=False)


def create_app(test_config=None):
    app = Flask(__name__, instance_relative_config=True)
    app.config.from_mapping(
        SECRET_KEY=os.getenv("SECRET_KEY", "local-development-only-change-me"),
        JWT_SECRET_KEY=os.getenv("JWT_SECRET_KEY", "local-jwt-only-change-me"),
        DEBUG=os.getenv("FLASK_DEBUG", "0") == "1",
        SQLALCHEMY_DATABASE_URI=os.getenv("DATABASE_URL", ""),
        SQLALCHEMY_TRACK_MODIFICATIONS=False,
        RATELIMIT_STORAGE_URI=os.getenv("RATELIMIT_STORAGE_URI", "memory://"),
        TRUSTED_PROXY_COUNT=int(os.getenv("TRUSTED_PROXY_COUNT", "0")),
        JWT_ACCESS_TOKEN_EXPIRES=int(os.getenv("ACCESS_TOKEN_MINUTES", "15")) * 60,
        JWT_REFRESH_TOKEN_EXPIRES=60 * 60 * 24 * 30,
        MAX_CONTENT_LENGTH=int(os.getenv("MAX_CONTENT_LENGTH", str(10 * 1024 * 1024))),
        UPLOAD_FOLDER=os.getenv("UPLOAD_FOLDER", str(Path(app.instance_path) / "uploads")),
        MAIL_SERVER=os.getenv("MAIL_SERVER", "smtp.gmail.com"),
        MAIL_PORT=int(os.getenv("MAIL_PORT", "587")),
        MAIL_USE_TLS=os.getenv("MAIL_USE_TLS", "true").lower() == "true",
        MAIL_USE_SSL=os.getenv("MAIL_USE_SSL", "false").lower() == "true",
        MAIL_USERNAME=os.getenv("MAIL_USERNAME", ""),
        MAIL_PASSWORD=os.getenv("MAIL_PASSWORD", ""),
        MAIL_DEFAULT_SENDER=os.getenv("MAIL_DEFAULT_SENDER") or os.getenv("MAIL_USERNAME", ""),
        FRONTEND_URL=os.getenv("FRONTEND_URL", "http://127.0.0.1:5173").rstrip("/"),
        RESET_TOKEN_MAX_AGE=int(os.getenv("RESET_TOKEN_MAX_AGE", "3600")),
        AI_SUPPORT_OLLAMA_BASE_URL=os.getenv("AI_SUPPORT_OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/"),
        AI_SUPPORT_CHAT_MODEL=os.getenv("AI_SUPPORT_CHAT_MODEL", "llama3.2:3b"),
        AI_SUPPORT_EMBEDDING_MODEL=os.getenv("AI_SUPPORT_EMBEDDING_MODEL", "nomic-embed-text"),
        AI_SUPPORT_KNOWLEDGE_DIR=os.getenv(
            "AI_SUPPORT_KNOWLEDGE_DIR",
            str(Path(app.root_path).parent / "knowledge_base"),
        ),
        AI_SUPPORT_MIN_RELEVANCE=float(os.getenv("AI_SUPPORT_MIN_RELEVANCE", "0.35")),
    )
    if test_config:
        app.config.update(test_config)
    if not app.config["SQLALCHEMY_DATABASE_URI"]:
        raise RuntimeError(
            "DATABASE_URL is required. Configure the Supabase connection with "
            "connect-supabase.cmd before starting the CRM."
        )
    app.config["SQLALCHEMY_DATABASE_URI"] = normalize_database_url(
        app.config["SQLALCHEMY_DATABASE_URI"]
    )
    if not 0 <= app.config["AI_SUPPORT_MIN_RELEVANCE"] <= 1:
        raise RuntimeError("AI_SUPPORT_MIN_RELEVANCE must be between 0 and 1.")
    database_url = make_url(app.config["SQLALCHEMY_DATABASE_URI"])
    if not app.config["TESTING"] and (
        database_url.drivername != "postgresql+psycopg"
        or database_url.host != "aws-0-ap-northeast-1.pooler.supabase.com"
        or database_url.database != "postgres"
        or not database_url.password
        or database_url.password in {"[YOUR-PASSWORD]", "YOUR_URL_ENCODED_PASSWORD"}
    ):
        raise RuntimeError(
            "NEXUS CRM requires the configured Supabase PostgreSQL "
            "session-pooler URL. Run connect-supabase.cmd to set it securely."
        )
    if not app.config["SECRET_KEY"] or not app.config["JWT_SECRET_KEY"]:
        raise RuntimeError("SECRET_KEY and JWT_SECRET_KEY must be configured.")
    if app.config["TRUSTED_PROXY_COUNT"] < 0:
        raise RuntimeError("TRUSTED_PROXY_COUNT cannot be negative.")
    if not app.config["TESTING"] and not app.config["DEBUG"]:
        secrets = (app.config["SECRET_KEY"], app.config["JWT_SECRET_KEY"])
        if any(
            len(secret.encode("utf-8")) < 32 or secret.startswith("replace-with-")
            for secret in secrets
        ):
            raise RuntimeError(
                "Set unique SECRET_KEY and JWT_SECRET_KEY values of at least 32 characters before deployment."
            )
        if secrets[0] == secrets[1]:
            raise RuntimeError("SECRET_KEY and JWT_SECRET_KEY must be different values.")

    Path(app.instance_path).mkdir(parents=True, exist_ok=True)
    Path(app.config["UPLOAD_FOLDER"]).mkdir(parents=True, exist_ok=True)
    if app.config["TRUSTED_PROXY_COUNT"]:
        proxy_count = app.config["TRUSTED_PROXY_COUNT"]
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=proxy_count, x_proto=proxy_count)
    db.init_app(app)
    limiter.storage_uri = app.config["RATELIMIT_STORAGE_URI"]
    limiter.init_app(app)
    mail.init_app(app)
    jwt.init_app(app)
    migrate.init_app(app, db)
    origins = {
        origin.strip()
        for origin in [*os.getenv("CORS_ORIGINS", "").split(","), app.config["FRONTEND_URL"]]
        if origin.strip()
    }
    CORS(app, resources={r"/api/*": {"origins": list(origins)}})
    socketio.init_app(
        app,
        async_mode="threading",
        cors_allowed_origins=list(origins),
    )

    from . import models  # noqa: F401
    from .api import api
    from .realtime import register_socket_handlers

    app.register_blueprint(api, url_prefix="/api/v1")
    register_socket_handlers(socketio)

    @app.get("/")
    def root():
        return jsonify({
            "name": "NEXUS CRM API",
            "status": "ok",
            "frontend": f"{app.config['FRONTEND_URL']}/login",
            "health": "/api/v1/health",
        })

    @jwt.token_in_blocklist_loader
    def is_token_revoked(_jwt_header, jwt_payload):
        from .models import RevokedToken
        if db.session.get(RevokedToken, jwt_payload["jti"]):
            return True
        identity = jwt_payload.get("sub")
        if not identity or not str(identity).isdigit():
            return True
        user = db.session.get(models.User, int(identity))
        return not user or not user.is_active or jwt_payload.get("token_version") != user.token_version

    @app.get("/api/v1/health")
    def health():
        try:
            db.session.execute(text("SELECT 1"))
        except Exception:
            app.logger.exception("Health check database probe failed")
            return jsonify({"status": "unhealthy"}), 503
        return jsonify({"status": "ok"})

    @app.errorhandler(413)
    def upload_too_large(_error):
        return jsonify({"error": "Uploaded data exceeds the configured size limit."}), 413

    @app.errorhandler(404)
    def not_found(_error):
        return jsonify({"error": "Resource not found."}), 404

    @app.cli.command("init-db")
    def init_db_command():
        """Create local development tables; use migrations in production."""
        db.create_all()
        click.echo("Database tables are ready.")

    @app.cli.command("seed")
    @click.option("--admin-email", envvar="CRM_ADMIN_EMAIL")
    @click.option("--admin-password", envvar="CRM_ADMIN_PASSWORD")
    @click.option("--admin-name", envvar="CRM_ADMIN_NAME", default="Main Admin")
    def seed_command(admin_email, admin_password, admin_name):
        """Create the standard roles, departments, products, and optional first admin."""
        from decimal import Decimal
        from .models import Department, Product, Role, User

        roles = (
            "CUSTOMER", "SALES_MANAGER", "PRODUCT_MAINTENANCE",
            "SUPPORT", "MAIN_ADMIN",
        )
        departments = (
            ("Sales", "sales"),
            ("Product Maintenance", "product-maintenance"),
            ("Support", "support"),
            ("Main Admin", "main-admin"),
        )
        for role_name in roles:
            if not Role.query.filter_by(name=role_name).first():
                db.session.add(Role(name=role_name))
        for name, slug in departments:
            if not Department.query.filter_by(slug=slug).first():
                db.session.add(Department(name=name, slug=slug))
        db.session.flush()
        admin_role = Role.query.filter_by(name="MAIN_ADMIN").one()
        if not User.query.filter_by(role=admin_role).first() and not (admin_email and admin_password):
            raise click.ClickException(
                "The first administrator is not configured. Set CRM_ADMIN_EMAIL and "
                "CRM_ADMIN_PASSWORD (at least 12 characters) before running seed."
            )
        if admin_email or admin_password:
            if not admin_email or not admin_password or len(admin_password) < 12:
                raise click.ClickException(
                    "Set CRM_ADMIN_EMAIL and CRM_ADMIN_PASSWORD (at least 12 characters) together."
                )
            existing = User.query.filter_by(email=admin_email.lower().strip()).first()
            if existing is None:
                from email_validator import EmailNotValidError, validate_email

                try:
                    normalized_email = validate_email(admin_email, check_deliverability=False).normalized.lower()
                except EmailNotValidError as exc:
                    raise click.ClickException("CRM_ADMIN_EMAIL must be a valid email address.") from exc
                admin = User(
                    name=admin_name.strip() or "Main Admin",
                    email=normalized_email,
                    role=admin_role,
                    department=Department.query.filter_by(slug="main-admin").one(),
                    email_verified_at=datetime.now(timezone.utc),
                )
                admin.set_password(admin_password)
                db.session.add(admin)
                click.echo(f"Created main admin account: {admin.email}")
            elif existing.role.name != "MAIN_ADMIN":
                raise click.ClickException("That email already belongs to a non-admin account.")
        examples = (
            ("Nexus CRM", "Software", "A customer relationship platform.", "49.00"),
            ("Nexus Support", "Support", "Priority product support.", "19.00"),
            ("Nexus Analytics", "Analytics", "Business reporting and insights.", "29.00"),
        )
        for name, category, description, price in examples:
            if not Product.query.filter_by(name=name).first():
                db.session.add(Product(
                    name=name, category=category, description=description,
                    price=Decimal(price), status="ACTIVE",
                ))
        db.session.commit()
        click.echo("Standard CRM roles, departments, and sample products are ready.")

    return app
