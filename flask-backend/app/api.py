import csv
import hashlib
import io
import logging
import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from functools import wraps
from pathlib import Path
from uuid import uuid4

from email_validator import EmailNotValidError, validate_email
from flask import Blueprint, current_app, jsonify, request, send_file
from flask_jwt_extended import (
    create_access_token,
    create_refresh_token,
    decode_token,
    get_jwt,
    get_jwt_identity,
    jwt_required,
)
from flask_jwt_extended.exceptions import JWTExtendedException
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
from sqlalchemy import and_, func, or_
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from werkzeug.utils import secure_filename

from .extensions import db, limiter
from .ai_support import (
    KnowledgeBaseUnavailable,
    OllamaUnavailable,
    answer_support_question,
    ollama_models_available,
    warmup_status,
)
from .models import (
    ActivityLog,
    AuditLog,
    Department,
    Enquiry,
    FeedbackReview,
    Lead,
    LeadApprovalHistory,
    LeadCommunication,
    Meeting,
    Notification,
    Product,
    ProductInterestEvent,
    RevokedToken,
    Role,
    Ticket,
    TicketComment,
    TicketDocument,
    User,
    utcnow,
)
from .services import (
    PRIORITIES,
    TICKET_CATEGORIES,
    TICKET_STATUSES,
    create_ticket_number,
    current_user,
    get_role,
    is_staff,
    make_token,
    notify_ticket_parties,
    notify_user,
    queue_crm_email,
    queue_lead_email,
    parse_datetime,
    read_token,
    record_action,
    route_ticket,
    sales_assignment_email_content,
    sales_enquiry_email_content,
    send_assignee_email,
    send_product_defect_email,
    send_ticket_email,
    send_user_email,
    ticket_visible_to,
    token_claims,
)

api = Blueprint("api", __name__)
logger = logging.getLogger(__name__)
FEEDBACK_PRIVATE_PATTERNS = (
    re.compile(r"\b[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+\b", re.IGNORECASE),
    re.compile(r"\b(?:password|passcode|access token|refresh token|api key|secret)\s*[:=]\s*\S+", re.IGNORECASE),
    re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"),
)
ALLOWED_UPLOAD_EXTENSIONS = {
    "pdf", "png", "jpg", "jpeg", "gif", "txt", "csv", "doc", "docx", "xls", "xlsx",
}
ROLE_DEPARTMENTS = {
    "SALES_MANAGER": "sales",
    "PRODUCT_MAINTENANCE": "product-maintenance",
    "SUPPORT": "support",
}
ROUTING_DEPARTMENT_SLUGS = {*ROLE_DEPARTMENTS.values(), "main-admin"}


def error(message, status=400, **details):
    payload = {"error": message}
    if details:
        payload["details"] = details
    return jsonify(payload), status


def staff_required(*roles):
    def decorate(function):
        @wraps(function)
        @jwt_required()
        def wrapped(*args, **kwargs):
            user = current_user()
            if not user or not user.is_active:
                return error("Authentication required.", 401)
            if not is_staff(user):
                return error("Staff access required.", 403)
            if roles and user.role.name not in roles:
                return error("Your role cannot perform this action.", 403)
            return function(*args, **kwargs)
        return wrapped
    return decorate


def authenticated(function):
    @wraps(function)
    @jwt_required()
    def wrapped(*args, **kwargs):
        user = current_user()
        if not user or not user.is_active:
            return error("Authentication required.", 401)
        return function(user, *args, **kwargs)
    return wrapped


def get_ticket_or_404(ticket_id):
    if str(ticket_id).isdigit():
        ticket = db.session.get(Ticket, int(ticket_id))
    else:
        ticket = Ticket.query.filter_by(ticket_number=str(ticket_id).upper()).first()
    return ticket


def ticket_status_payload(ticket):
    return {
        "id": ticket.id,
        "ticket_number": ticket.ticket_number,
        "status": ticket.status,
    }


def notification_payload(user, notification):
    payload = notification.to_dict()
    if user.role.name == "MAIN_ADMIN" and notification.ticket_id:
        ticket = db.session.get(Ticket, notification.ticket_id)
        payload.update(
            title="Ticket status update",
            body=(
                f"{ticket.ticket_number}: {ticket.status.replace('_', ' ').title()}."
                if ticket else "Ticket status is unavailable."
            ),
            link="",
        )
    return payload


def create_email_verification(user):
    token = make_token(user.email, "email-verification")
    link = f"{current_app.config['FRONTEND_URL']}/verify-email?token={token}"
    delivered = send_user_email(
        user.email,
        "Verify your NEXUS CRM account",
        f"Hello {user.name},\n\nVerify your account: {link}",
    )
    if not delivered and current_app.debug:
        logger.info("Development verification link for %s: %s", user.email, link)
    return delivered, link


@api.post("/auth/register")
@api.post("/auth/signup")
@api.post("/auth/signup/")
@limiter.limit("5 per hour")
def register():
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", data.get("full_name", ""))).strip()
    email = str(data.get("email", "")).strip().lower()
    password = data.get("password")
    if not name or len(name) > 160:
        return error("Name is required and must be at most 160 characters.")
    if not isinstance(password, str) or len(password) < 12 or len(password) > 128:
        return error("Password must be between 12 and 128 characters.")
    try:
        email = validate_email(email, check_deliverability=False).normalized.lower()
    except (EmailNotValidError, AttributeError):
        return error("Enter a valid email address.")
    if User.query.filter(func.lower(User.email) == email).first():
        return error("An account with that email already exists.", 409)
    user = User(
        name=name,
        email=email,
        role=get_role("CUSTOMER"),
        email_verified_at=utcnow(),
    )
    user.set_password(password)
    db.session.add(user)
    db.session.flush()
    notify_user(user, "REGISTRATION", "Welcome to NEXUS CRM", "Your account was created.")
    record_action(user, "REGISTER", "User", user.id, "Customer account created.")
    db.session.commit()
    return jsonify({"message": "Account created. You can now sign in."}), 201


@api.post("/auth/verify-email")
@api.post("/auth/verify-email/")
def verify_email():
    data = request.get_json(silent=True) or {}
    email = read_token(str(data.get("token", "")), "email-verification")
    if not email:
        return error("Verification link is invalid or expired.", 400)
    user = User.query.filter(func.lower(User.email) == email).first()
    if not user:
        return error("Verification link is invalid or expired.", 400)
    if user.email_verified_at is None:
        user.email_verified_at = utcnow()
        record_action(user, "VERIFY_EMAIL", "User", user.id, "Email address verified.")
        db.session.commit()
    return jsonify({"email_verified": True})


@api.post("/auth/verification/request")
@api.post("/auth/verify-email/request/")
@limiter.limit("5 per hour")
def resend_verification():
    email = str((request.get_json(silent=True) or {}).get("email", "")).strip().lower()
    user = User.query.filter(func.lower(User.email) == email, User.is_active.is_(True)).first()
    if user and user.email_verified_at is None:
        create_email_verification(user)
        db.session.commit()
    return jsonify({"message": "If the account needs verification, a new link has been sent."})


@api.post("/auth/login")
@api.post("/auth/token")
@api.post("/auth/token/")
@limiter.limit("10 per minute")
def login():
    data = request.get_json(silent=True) or {}
    email = str(data.get("email", "")).strip().lower()
    password = data.get("password")
    user = User.query.filter(func.lower(User.email) == email, User.is_active.is_(True)).first()
    if not user or not isinstance(password, str) or not user.check_password(password):
        return error("Invalid email or password.", 401)
    record_action(user, "LOGIN", "User", user.id, "User signed in.")
    db.session.commit()
    return jsonify({
        "access": create_access_token(identity=str(user.id), additional_claims=token_claims(user)),
        "refresh": create_refresh_token(identity=str(user.id), additional_claims=token_claims(user)),
        "user": user.to_dict(),
    })


@api.post("/auth/refresh")
@api.post("/auth/token/refresh")
@api.post("/auth/token/refresh/")
def refresh_token():
    raw_token = (request.get_json(silent=True) or {}).get("refresh", "")
    if not isinstance(raw_token, str) or not raw_token:
        return error("A refresh token is required.", 401)
    try:
        claims = decode_token(raw_token)
    except JWTExtendedException:
        return error("Refresh token is invalid or expired.", 401)
    identity = claims.get("sub")
    user = db.session.get(User, int(identity)) if identity and str(identity).isdigit() else None
    if (
        claims.get("type") != "refresh"
        or not user
        or not user.is_active
        or claims.get("token_version") != user.token_version
        or db.session.get(RevokedToken, claims.get("jti"))
    ):
        return error("Account is unavailable.", 401)
    db.session.add(RevokedToken(jti=claims["jti"]))
    response = {
        "access": create_access_token(identity=str(user.id), additional_claims=token_claims(user)),
        "refresh": create_refresh_token(identity=str(user.id), additional_claims=token_claims(user)),
    }
    db.session.commit()
    return jsonify(response)


@api.post("/auth/logout")
@api.post("/auth/logout/")
@jwt_required()
def logout():
    jti = get_jwt()["jti"]
    db.session.merge(RevokedToken(jti=jti))
    user = current_user()
    if user:
        user.token_version += 1
        record_action(user, "LOGOUT", "User", user.id, "User signed out.")
    db.session.commit()
    return jsonify({"logged_out": True})


@api.get("/auth/me")
@authenticated
def me(user):
    return jsonify(user.to_dict())


def feedback_pagination():
    try:
        page = int(request.args.get("page", "1"))
        per_page = int(request.args.get("per_page", "10"))
    except (TypeError, ValueError):
        return None, error("Page and per_page must be integers.")
    if page < 1 or page > 100000 or per_page < 1 or per_page > 50:
        return None, error("Page must be positive and per_page must be between 1 and 50.")
    return (page, per_page), None


def feedback_payload(review, include_status=False, public=False):
    value = {
        "id": review.id,
        "title": public_feedback_text(review.title) if public and review.title else review.title,
        "comment": public_feedback_text(review.comment) if public else review.comment,
        "rating": review.rating,
        "display_name": (
            public_feedback_text(review.display_name)
            if public and review.display_name
            else review.display_name or "Anonymous customer"
        ),
        "created_at": review.created_at.isoformat(),
    }
    if include_status:
        value["status"] = review.status
    return value


def public_feedback_text(value):
    for pattern in FEEDBACK_PRIVATE_PATTERNS:
        value = pattern.sub("[redacted]", value)
    return value


def feedback_contains_private_data(*values):
    return any(
        pattern.search(value)
        for value in values
        if value
        for pattern in FEEDBACK_PRIVATE_PATTERNS
    )


@api.get("/feedback/public")
@limiter.limit("60 per minute")
def public_feedback():
    pagination, response = feedback_pagination()
    if response:
        return response
    page, per_page = pagination
    try:
        approved = FeedbackReview.query.filter_by(status="approved")
        summary = approved.with_entities(
            func.count(FeedbackReview.id),
            func.avg(FeedbackReview.rating),
        ).one()
        total = summary[0]
        average = float(summary[1]) if summary[1] is not None else None
        query = approved
        rating_value = request.args.get("rating")
        if rating_value is not None:
            try:
                rating = int(rating_value)
            except (TypeError, ValueError):
                return error("Rating must be an integer between 1 and 5.")
            if rating < 1 or rating > 5:
                return error("Rating must be an integer between 1 and 5.")
            query = query.filter(FeedbackReview.rating == rating)
        reviews = (
            query.order_by(FeedbackReview.created_at.desc(), FeedbackReview.id.desc())
            .offset((page - 1) * per_page)
            .limit(per_page)
            .all()
        )
        filtered_total = query.with_entities(func.count(FeedbackReview.id)).scalar()
        return jsonify({
            "average_rating": round(average, 2) if average is not None else None,
            "total_reviews": total,
            "results": [feedback_payload(review, public=True) for review in reviews],
            "page": page,
            "per_page": per_page,
            "total": filtered_total,
        })
    except SQLAlchemyError:
        db.session.rollback()
        logger.exception("Could not load public customer feedback.")
        return error("Feedback is temporarily unavailable.", 503)


@api.post("/feedback")
@authenticated
@limiter.limit("10 per hour")
def submit_feedback(user):
    if user.role.name != "CUSTOMER":
        return error("Customer access required.", 403)
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return error("Feedback must be provided as a JSON object.")
    rating = data.get("rating")
    if type(rating) is not int or rating < 1 or rating > 5:
        return error("Rating must be an integer between 1 and 5.")
    comment = data.get("comment")
    if not isinstance(comment, str):
        return error("A comment is required.")
    comment = comment.strip()
    if not comment:
        return error("A comment is required.")
    if len(comment) > 3000:
        return error("Comment must be at most 3000 characters.")
    title = data.get("title", "")
    if not isinstance(title, str):
        return error("Title must be text.")
    title = title.strip()
    if len(title) > 120:
        return error("Title must be at most 120 characters.")
    display_name = data.get("display_name")
    if display_name is not None:
        if not isinstance(display_name, str):
            return error("Display name must be text.")
        display_name = display_name.strip()
        if len(display_name) > 80:
            return error("Display name must be at most 80 characters.")
        if not display_name:
            display_name = None
    if feedback_contains_private_data(comment, title, display_name):
        return error("Remove email addresses and credentials before submitting public feedback.")
    review = FeedbackReview(
        customer_id=user.id,
        title=title or None,
        comment=comment,
        rating=rating,
        display_name=display_name,
    )
    try:
        db.session.add(review)
        db.session.commit()
    except SQLAlchemyError:
        db.session.rollback()
        logger.exception("Could not save customer feedback.")
        return error("Feedback could not be submitted. Please try again later.", 503)
    return jsonify({"review": feedback_payload(review, include_status=True)}), 201


@api.get("/feedback/mine")
@authenticated
def my_feedback(user):
    if user.role.name != "CUSTOMER":
        return error("Customer access required.", 403)
    pagination, response = feedback_pagination()
    if response:
        return response
    page, per_page = pagination
    try:
        query = FeedbackReview.query.filter_by(customer_id=user.id)
        total = query.with_entities(func.count(FeedbackReview.id)).scalar()
        reviews = (
            query.order_by(FeedbackReview.created_at.desc(), FeedbackReview.id.desc())
            .offset((page - 1) * per_page)
            .limit(per_page)
            .all()
        )
        return jsonify({
            "results": [feedback_payload(review, include_status=True) for review in reviews],
            "page": page,
            "per_page": per_page,
            "total": total,
        })
    except SQLAlchemyError:
        db.session.rollback()
        logger.exception("Could not load a customer's feedback history.")
        return error("Feedback history is temporarily unavailable.", 503)


@api.get("/admin/feedback")
@staff_required("MAIN_ADMIN")
def list_feedback():
    pagination, response = feedback_pagination()
    if response:
        return response
    page, per_page = pagination
    status = request.args.get("status", "pending")
    if status not in {"pending", "approved", "rejected", "all"}:
        return error("Status must be pending, approved, rejected, or all.")
    try:
        query = FeedbackReview.query
        if status != "all":
            query = query.filter_by(status=status)
        total = query.with_entities(func.count(FeedbackReview.id)).scalar()
        reviews = (
            query.order_by(FeedbackReview.created_at.desc(), FeedbackReview.id.desc())
            .offset((page - 1) * per_page)
            .limit(per_page)
            .all()
        )
        return jsonify({
            "results": [feedback_payload(review, include_status=True) for review in reviews],
            "page": page,
            "per_page": per_page,
            "total": total,
        })
    except SQLAlchemyError:
        db.session.rollback()
        logger.exception("Could not load the feedback moderation queue.")
        return error("Feedback moderation is temporarily unavailable.", 503)


@api.patch("/admin/feedback/<review_id>")
@staff_required("MAIN_ADMIN")
def moderate_feedback(review_id):
    if not review_id.isdigit() or int(review_id) < 1:
        return error("Review ID must be a positive integer.")
    data = request.get_json(silent=True)
    if (
        not isinstance(data, dict)
        or not isinstance(data.get("status"), str)
        or data["status"] not in {"approved", "rejected"}
    ):
        return error("Status must be approved or rejected.")
    try:
        review = db.session.get(FeedbackReview, int(review_id))
        if review is None:
            return error("Review not found.", 404)
        review.status = data["status"]
        review.moderated_at = utcnow()
        review.moderator_id = current_user().id
        record_action(
            current_user(),
            "FEEDBACK_MODERATED",
            "FeedbackReview",
            review.id,
            f"Customer feedback was {review.status}.",
            {"status": review.status},
        )
        db.session.commit()
        return jsonify({"review": feedback_payload(review, include_status=True)})
    except SQLAlchemyError:
        db.session.rollback()
        logger.exception("Could not moderate customer feedback %s.", review_id)
        return error("Feedback could not be moderated. Please try again later.", 503)


@api.post("/auth/password-reset/request")
@api.post("/auth/password-reset")
@api.post("/auth/password-reset/")
@limiter.limit("5 per hour")
def request_password_reset():
    email = str((request.get_json(silent=True) or {}).get("email", "")).strip().lower()
    user = User.query.filter(func.lower(User.email) == email, User.is_active.is_(True)).first()
    reset_link = None
    if user:
        token = make_token(user.email, "password-reset", user.token_version)
        reset_link = f"{current_app.config['FRONTEND_URL']}/reset-password?token={token}"
        send_user_email(
            user.email,
            "Reset your NEXUS CRM password",
            f"Reset your password using this link:\n{reset_link}",
        )
        record_action(user, "PASSWORD_RESET_REQUEST", "User", user.id, "Password reset requested.")
        db.session.commit()
    response = {"message": "If an account exists for that email, a reset link has been sent."}
    if current_app.debug and reset_link:
        response["development_reset_url"] = reset_link
    return jsonify(response)


@api.post("/auth/password-reset/confirm")
@api.post("/auth/password-reset/confirm/")
def confirm_password_reset():
    data = request.get_json(silent=True) or {}
    reset_claim = read_token(str(data.get("token", "")), "password-reset")
    password = data.get("password", data.get("new_password"))
    if not isinstance(reset_claim, dict):
        return error("Password reset link is invalid or expired.", 400)
    if not isinstance(password, str) or len(password) < 12 or len(password) > 128:
        return error("Password must be between 12 and 128 characters.")
    user = User.query.filter(
        func.lower(User.email) == reset_claim.get("email"),
        User.is_active.is_(True),
    ).first()
    if not user or reset_claim.get("version") != user.token_version:
        return error("Password reset link is invalid or expired.", 400)
    user.set_password(password)
    user.token_version += 1
    record_action(user, "PASSWORD_RESET", "User", user.id, "Password was reset.")
    db.session.commit()
    return jsonify({"password_reset": True})


@api.get("/products")
@api.get("/products/")
def list_products():
    query = Product.query
    if request.args.get("status") != "all":
        query = query.filter_by(status="ACTIVE")
    category = request.args.get("category")
    search = request.args.get("search", "").strip()
    if category:
        query = query.filter(Product.category == category)
    if search:
        query = query.filter(or_(Product.name.ilike(f"%{search}%"), Product.description.ilike(f"%{search}%")))
    products = query.order_by(Product.name).limit(200).all()
    return jsonify([product.to_dict() for product in products])


def product_from_data(data, product=None):
    name = str(data.get("name", product.name if product else "")).strip()
    category = str(data.get("category", product.category if product else "")).strip()
    if not name or not category or len(name) > 180 or len(category) > 100:
        return None, "Product name and category are required."
    try:
        price = Decimal(str(data.get("price", product.price if product else 0)))
        if (
            not price.is_finite()
            or price < 0
            or price > Decimal("9999999999.99")
            or price.quantize(Decimal("0.01")) != price
        ):
            raise InvalidOperation
    except (InvalidOperation, ValueError):
        return None, "Price must be a non-negative amount with at most two decimal places."
    status = str(data.get("status", product.status if product else "ACTIVE")).upper()
    if status not in {"ACTIVE", "INACTIVE"}:
        return None, "Status must be ACTIVE or INACTIVE."
    values = {
        "name": name,
        "category": category,
        "description": str(data.get("description", product.description if product else "")).strip(),
        "price": price,
        "status": status,
    }
    return values, None


@api.post("/products")
@api.post("/products/")
@staff_required("MAIN_ADMIN")
def create_product():
    data = request.get_json(silent=True) or {}
    values, message = product_from_data(data)
    if message:
        return error(message)
    product = Product(**values)
    db.session.add(product)
    db.session.flush()
    record_action(current_user(), "CREATE", "Product", product.id, f"Created product {product.name}.")
    db.session.commit()
    return jsonify(product.to_dict()), 201


@api.route("/products/<int:product_id>", methods=["PUT", "PATCH"])
@staff_required("MAIN_ADMIN")
def update_product(product_id):
    product = db.session.get(Product, product_id)
    if not product:
        return error("Product not found.", 404)
    values, message = product_from_data(request.get_json(silent=True) or {}, product)
    if message:
        return error(message)
    for key, value in values.items():
        setattr(product, key, value)
    record_action(current_user(), "UPDATE", "Product", product.id, f"Updated product {product.name}.")
    db.session.commit()
    return jsonify(product.to_dict())


@api.delete("/products/<int:product_id>")
@staff_required("MAIN_ADMIN")
def delete_product(product_id):
    product = db.session.get(Product, product_id)
    if not product:
        return error("Product not found.", 404)
    if Ticket.query.filter_by(product_id=product.id).first():
        return error("A product referenced by a ticket cannot be deleted; deactivate it instead.", 409)
    record_action(current_user(), "DELETE", "Product", product.id, f"Deleted product {product.name}.")
    db.session.delete(product)
    db.session.commit()
    return "", 204


@api.get("/ai-support/health")
@authenticated
def ai_support_health(_user):
    try:
        if not ollama_models_available():
            return jsonify({
                "status": "models_missing",
                "message": "Ollama is running, but required local models are not available.",
            }), 503
    except OllamaUnavailable as exc:
        logger.warning("Ollama health check failed: %s", exc)
        return jsonify({
            "status": "unavailable",
            "message": "Ollama is not reachable from the CRM API.",
        }), 503
    return jsonify({"status": warmup_status()})


@api.post("/ai-support/chat")
@authenticated
@limiter.limit("15 per minute")
def ai_support_chat(_user):
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return error("A JSON object is required.")
    message = data.get("message")
    if not isinstance(message, str) or not message.strip() or len(message) > 2000:
        return error("A message is required and cannot exceed 2000 characters.")
    raw_history = data.get("history", [])
    if not isinstance(raw_history, list) or len(raw_history) > 10:
        return error("Chat history must contain at most 10 messages.")
    history = []
    for item in raw_history:
        if (
            not isinstance(item, dict)
            or item.get("role") not in {"user", "assistant"}
            or not isinstance(item.get("content"), str)
            or not item["content"].strip()
            or len(item["content"]) > 2000
        ):
            return error("Chat history contains an invalid message.")
        history.append({"role": item["role"], "content": item["content"].strip()})
    try:
        return jsonify(answer_support_question(message.strip(), history))
    except OllamaUnavailable as exc:
        logger.warning("Ollama support chat request failed: %s", exc)
        return error("Local AI support is temporarily unavailable. Please try again later.", 503)
    except KnowledgeBaseUnavailable:
        logger.exception("AI support knowledge base could not be loaded.")
        return error("Support information is temporarily unavailable. Please contact human support.", 503)


@api.post("/tickets")
@api.post("/ticket/create")
@api.post("/ticket/create/")
@api.post("/tickets/")
@authenticated
def create_ticket(user):
    data = request.get_json(silent=True) or {}
    category = str(data.get("issue_category", data.get("category", ""))).upper()
    priority = "MEDIUM" if user.role.name == "CUSTOMER" else str(data.get("priority", "MEDIUM")).upper()
    subject = str(data.get("subject", "")).strip()
    description = str(data.get("description", "")).strip()
    if category not in TICKET_CATEGORIES:
        return error("issue_category must be PRODUCT_ENQUIRY, PRODUCT_DEFECT, or TECHNICAL_SUPPORT.")
    if priority not in PRIORITIES:
        return error("priority must be LOW, MEDIUM, HIGH, or CRITICAL.")
    if not subject or len(subject) > 240 or not description or len(description) > 20000:
        return error("A subject (max 240 characters) and description (max 20,000 characters) are required.")
    if user.role.name != "CUSTOMER":
        return error("Only customers can create customer tickets.", 403)
    product = None
    product_id = data.get("product_id")
    if product_id is not None:
        if not str(product_id).isdigit():
            return error("product_id must be an integer.")
        product = db.session.get(Product, int(product_id))
        if not product or product.status != "ACTIVE":
            return error("Active product not found.", 404)
    department, assignee = route_ticket(category, priority)
    ticket = Ticket(
        ticket_number=create_ticket_number(),
        customer_id=user.id,
        product_id=product.id if product else None,
        issue_category=category,
        subject=subject,
        description=description,
        priority=priority,
        status="ASSIGNED" if assignee else "NEW",
        department_id=department.id,
        assignee_id=assignee.id if assignee else None,
    )
    db.session.add(ticket)
    try:
        db.session.flush()
    except IntegrityError:
        db.session.rollback()
        return error("The support request conflicted with another submission; please retry.", 409)
    except SQLAlchemyError:
        db.session.rollback()
        logger.exception("Database error while creating support ticket for customer %s.", visitor.id)
        return error("The support request could not be saved.", 500)
    record_action(user, "CREATE", "Ticket", ticket.id, f"Created ticket {ticket.ticket_number}.",
                  {"priority": priority, "category": category, "department": department.name})
    notify_user(user, "TICKET_CREATED", "Ticket created",
                f"{ticket.ticket_number} was created and routed to {department.name}.", ticket)
    if assignee:
        notify_user(
            assignee,
            "TICKET_ASSIGNMENT",
            "Ticket status update" if assignee.role.name == "MAIN_ADMIN" else "Ticket assigned to you",
            f"{ticket.ticket_number}: {ticket.status.replace('_', ' ').title()}."
            if assignee.role.name == "MAIN_ADMIN"
            else f"{ticket.ticket_number}: {ticket.subject}",
            ticket,
        )
    if priority == "CRITICAL":
        admins = User.query.join(Role).filter(Role.name == "MAIN_ADMIN", User.is_active.is_(True)).all()
        for admin in admins:
            if not assignee or admin.id != assignee.id:
                notify_user(admin, "CRITICAL_TICKET", "Ticket status update",
                            f"{ticket.ticket_number}: {ticket.status.replace('_', ' ').title()}.", ticket)
        from .realtime import emit_to_department
        emit_to_department(
            department.id,
            "critical_ticket",
            ticket_status_payload(ticket) if department.slug == "main-admin" else ticket.to_dict(),
        )
    db.session.commit()
    email_sent = send_ticket_email(ticket, "Ticket created")
    if category == "PRODUCT_DEFECT" and department.slug == "product-maintenance":
        send_product_defect_email(ticket)
    elif ticket.assignee and ticket.assignee.role.name != "MAIN_ADMIN":
        send_assignee_email(ticket, "New ticket assignment")
    from .realtime import emit_to_department, emit_to_user
    emit_to_department(
        department.id,
        "ticket_created",
        ticket_status_payload(ticket) if department.slug == "main-admin" else ticket.to_dict(),
    )
    emit_to_user(user.id, "ticket_created", ticket.to_dict())
    return jsonify({"ticket": ticket.to_dict(), "email_sent": email_sent}), 201


@api.get("/tickets")
@api.get("/ticket")
@api.get("/tickets/")
@authenticated
def list_tickets(user):
    query = Ticket.query
    if user.role.name == "CUSTOMER":
        query = query.filter_by(customer_id=user.id)
    elif user.role.name != "MAIN_ADMIN":
        query = query.filter(or_(Ticket.department_id == user.department_id, Ticket.assignee_id == user.id))
    status_counts_query = query
    search = request.args.get("search", "").strip()
    if user.role.name == "MAIN_ADMIN" and any(
        request.args.get(field)
        for field in ("search", "priority", "issue_category", "department_id")
    ):
        return error("Main Admin can filter tickets by status only.", 403)
    if search:
        query = query.join(User, Ticket.customer_id == User.id).filter(or_(
            Ticket.ticket_number.ilike(f"%{search}%"),
            Ticket.subject.ilike(f"%{search}%"),
            User.name.ilike(f"%{search}%"),
        ))
    for field, allowed in (("priority", PRIORITIES), ("status", TICKET_STATUSES), ("issue_category", TICKET_CATEGORIES)):
        value = request.args.get(field)
        if value:
            value = value.upper()
            if value not in allowed:
                return error(f"Invalid {field} filter.")
            query = query.filter(getattr(Ticket, field) == value)
    department_id = request.args.get("department_id")
    if department_id:
        if user.role.name != "MAIN_ADMIN":
            return error("Only the main admin can filter across departments.", 403)
        if not department_id.isdigit():
            return error("department_id must be an integer.")
        query = query.filter_by(department_id=int(department_id))
    sort = request.args.get(
        "sort",
        "status" if user.role.name == "MAIN_ADMIN" else "created_at",
    )
    direction = request.args.get("direction", "desc").lower()
    sort_fields = {"created_at": Ticket.created_at, "updated_at": Ticket.updated_at, "priority": Ticket.priority, "status": Ticket.status}
    if (
        sort not in sort_fields
        or direction not in {"asc", "desc"}
        or (user.role.name == "MAIN_ADMIN" and sort != "status")
    ):
        return error("Unsupported sort field or direction.")
    order = sort_fields[sort].asc() if direction == "asc" else sort_fields[sort].desc()
    try:
        page = max(1, int(request.args.get("page", "1")))
        per_page = min(100, max(1, int(request.args.get("per_page", "25"))))
    except ValueError:
        return error("page and per_page must be integers.")
    total = query.count()
    tickets = query.order_by(order, Ticket.id.desc()).offset((page - 1) * per_page).limit(per_page).all()
    status_counts = {status: 0 for status in TICKET_STATUSES}
    status_counts.update(dict(
        status_counts_query.with_entities(Ticket.status, func.count(Ticket.id))
        .group_by(Ticket.status)
        .all()
    ))
    results = [ticket.to_dict() for ticket in tickets]
    return jsonify({
        "results": results,
        "page": page,
        "per_page": per_page,
        "total": total,
        "pages": (total + per_page - 1) // per_page,
        "status_counts": status_counts,
    })


@api.get("/tickets/<ticket_id>")
@api.get("/ticket/<ticket_id>")
@authenticated
def get_ticket(user, ticket_id):
    ticket = get_ticket_or_404(ticket_id)
    if not ticket:
        return error("Ticket not found.", 404)
    if not ticket_visible_to(user, ticket):
        return error("You cannot access this ticket.", 403)
    if user.role.name == "MAIN_ADMIN":
        return jsonify(ticket.to_dict())
    return jsonify(ticket.to_dict(
        include_comments=True,
        include_internal_comments=user.role.name != "CUSTOMER",
    ))


@api.route("/tickets/<ticket_id>", methods=["PUT", "PATCH"])
@api.route("/ticket/update/<ticket_id>", methods=["PUT", "PATCH"])
@authenticated
def update_ticket(user, ticket_id):
    ticket = get_ticket_or_404(ticket_id)
    if not ticket:
        return error("Ticket not found.", 404)
    if not ticket_visible_to(user, ticket):
        return error("You cannot access this ticket.", 403)
    if not is_staff(user):
        return error("Customers cannot update ticket routing or status.", 403)
    if user.role.name == "MAIN_ADMIN":
        return error("Main Admin can view ticket details but cannot update tickets.", 403)
    data = request.get_json(silent=True) or {}
    if "priority" in data and user.department_id != ticket.department_id:
        return error("Only staff in the ticket's assigned department can change its priority.", 403)
    old_status = ticket.status
    old_assignee_id = ticket.assignee_id
    old_department_id = ticket.department_id
    changed = {}
    if "status" in data:
        status = str(data["status"]).upper()
        if status not in TICKET_STATUSES:
            return error("Unsupported ticket status.")
        ticket.status = status
        changed["status"] = status
    if "priority" in data:
        priority = str(data["priority"]).upper()
        if priority not in PRIORITIES:
            return error("Unsupported ticket priority.")
        ticket.priority = priority
        changed["priority"] = priority
    if "department_id" in data or "assignee_id" in data:
        if user.role.name != "MAIN_ADMIN":
            return error("Only the main admin can manually reassign a ticket.", 403)
        department_id = data.get("department_id", ticket.department_id)
        assignee_id = data.get("assignee_id", ticket.assignee_id)
        department = db.session.get(Department, department_id) if str(department_id).isdigit() else None
        assignee = db.session.get(User, assignee_id) if assignee_id and str(assignee_id).isdigit() else None
        if not department:
            return error("A valid department_id is required.")
        if assignee and (not assignee.is_active or assignee.department_id != department.id):
            return error("Assignee must be an active user in the selected department.")
        ticket.department_id = department.id
        ticket.assignee_id = assignee.id if assignee else None
        changed.update({"department_id": department.id, "assignee_id": ticket.assignee_id})
        if assignee:
            ticket.status = "ASSIGNED"
    ticket.updated_at = utcnow()
    record_action(user, "UPDATE", "Ticket", ticket.id, f"Updated ticket {ticket.ticket_number}.", changed)
    notification_kind = {
        "RESOLVED": "TICKET_RESOLVED",
        "CLOSED": "TICKET_CLOSED",
    }.get(ticket.status, "TICKET_UPDATED")
    status_message = f"{ticket.ticket_number} status: {ticket.status.replace('_', ' ').title()}."
    if old_assignee_id != ticket.assignee_id or old_department_id != ticket.department_id:
        if ticket.assignee:
            notify_user(ticket.assignee, "TICKET_ASSIGNMENT", "Ticket assigned to you",
                        f"{ticket.ticket_number}: {ticket.subject}", ticket)
        notify_user(ticket.customer, notification_kind, "Ticket updated", status_message, ticket)
    else:
        notify_ticket_parties(ticket, notification_kind, "Ticket updated", status_message)
    db.session.commit()
    if ticket.status in {"RESOLVED", "CLOSED"} and old_status != ticket.status:
        send_ticket_email(ticket, f"Ticket {ticket.status.lower()}")
    if ticket.assignee:
        send_assignee_email(ticket, "Ticket assignment updated")
    from .realtime import emit_to_admins, emit_to_department, emit_to_user
    emit_to_department(ticket.department_id, "ticket_updated", ticket.to_dict())
    emit_to_user(ticket.customer_id, "ticket_updated", ticket.to_dict())
    if old_status != ticket.status:
        emit_to_admins("ticket_updated", ticket_status_payload(ticket))
    return jsonify(ticket.to_dict(include_comments=True))


@api.post("/tickets/<ticket_id>/comments")
@api.post("/ticket/<ticket_id>/comments")
@authenticated
def add_ticket_comment(user, ticket_id):
    ticket = get_ticket_or_404(ticket_id)
    if not ticket:
        return error("Ticket not found.", 404)
    if not ticket_visible_to(user, ticket):
        return error("You cannot access this ticket.", 403)
    if user.role.name == "MAIN_ADMIN":
        return error("Main Admin can view ticket details but cannot access ticket conversations.", 403)
    data = request.get_json(silent=True) or {}
    body = str(data.get("body", "")).strip()
    if not body or len(body) > 10000:
        return error("Comment is required and must be at most 10,000 characters.")
    internal = bool(data.get("is_internal", False))
    if internal and user.role.name != "MAIN_ADMIN":
        return error("Only the main admin can add internal comments.", 403)
    comment = TicketComment(ticket_id=ticket.id, author_id=user.id, body=body, is_internal=internal)
    db.session.add(comment)
    record_action(user, "COMMENT", "Ticket", ticket.id, f"Comment added to {ticket.ticket_number}.")
    db.session.commit()
    notify_ticket_parties(ticket, "TICKET_COMMENT", "New ticket message", f"New message on {ticket.ticket_number}.",
                          include_customer=not internal)
    db.session.commit()
    from .realtime import emit_to_department, emit_to_user
    emit_to_department(ticket.department_id, "ticket_comment", {
        "ticket_id": ticket.id,
        "comment": comment.to_dict(),
    })
    if not internal:
        emit_to_user(ticket.customer_id, "ticket_comment", {
            "ticket_id": ticket.id,
            "comment": comment.to_dict(),
        })
    if ticket.assignee_id:
        emit_to_user(ticket.assignee_id, "ticket_comment", {
            "ticket_id": ticket.id,
            "comment": comment.to_dict(),
        })
    if not internal:
        send_ticket_email(ticket, "New ticket message")
    return jsonify(comment.to_dict()), 201


@api.post("/tickets/<ticket_id>/documents")
@api.post("/ticket/<ticket_id>/documents")
@authenticated
def upload_ticket_document(user, ticket_id):
    ticket = get_ticket_or_404(ticket_id)
    if not ticket:
        return error("Ticket not found.", 404)
    if not ticket_visible_to(user, ticket):
        return error("You cannot access this ticket.", 403)
    if user.role.name == "MAIN_ADMIN":
        return error("Main Admin can view ticket details but cannot access ticket documents.", 403)
    upload = request.files.get("file")
    if upload is None or not upload.filename:
        return error("Select a file to upload.")
    original_name = secure_filename(upload.filename)
    extension = Path(original_name).suffix.lower().lstrip(".")
    if not original_name or extension not in ALLOWED_UPLOAD_EXTENSIONS:
        return error("Unsupported file type.")
    stored_name = f"{uuid4().hex}.{extension}"
    destination = Path(current_app.config["UPLOAD_FOLDER"]) / stored_name
    upload.save(destination)
    document = TicketDocument(
        ticket_id=ticket.id,
        uploaded_by_id=user.id,
        original_name=original_name[:255],
        stored_name=stored_name,
        content_type=(upload.mimetype or "application/octet-stream")[:120],
    )
    db.session.add(document)
    record_action(user, "UPLOAD", "TicketDocument", stored_name, f"Document uploaded to {ticket.ticket_number}.")
    db.session.commit()
    return jsonify(document.to_dict()), 201


@api.get("/tickets/<ticket_id>/documents/<int:document_id>")
@authenticated
def download_ticket_document(user, ticket_id, document_id):
    ticket = get_ticket_or_404(ticket_id)
    document = db.session.get(TicketDocument, document_id)
    if not ticket or not document or document.ticket_id != ticket.id:
        return error("Document not found.", 404)
    if not ticket_visible_to(user, ticket):
        return error("You cannot access this document.", 403)
    if user.role.name == "MAIN_ADMIN":
        return error("Main Admin can view ticket details but cannot access ticket documents.", 403)
    destination = Path(current_app.config["UPLOAD_FOLDER"]) / document.stored_name
    if not destination.is_file():
        logger.error("Document record exists but file is missing: %s", document.id)
        return error("Document file is unavailable.", 410)
    response = send_file(destination, as_attachment=True, download_name=document.original_name, mimetype=document.content_type)
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@api.post("/meetings")
@api.post("/meeting/create")
@api.post("/meeting/create/")
@api.post("/meetings/")
@authenticated
def create_meeting(user):
    if not is_staff(user):
        return error("Only staff can schedule meetings.", 403)
    data = request.get_json(silent=True) or {}
    ticket_id = data.get("ticket_id")
    lead_id = data.get("lead_id")
    if (ticket_id is None) == (lead_id is None):
        return error("Provide exactly one ticket_id or lead_id.")

    ticket = None
    lead = None
    if ticket_id is not None:
        ticket = get_ticket_or_404(ticket_id)
        if not ticket:
            return error("Ticket not found.", 404)
        if not ticket_visible_to(user, ticket):
            return error("You cannot schedule meetings for this ticket.", 403)
        if user.role.name == "MAIN_ADMIN":
            return error("Main Admin can view ticket details but cannot schedule ticket meetings.", 403)
    else:
        if user.role.name not in {"SALES_MANAGER", "MAIN_ADMIN"}:
            return error("Only Sales Managers and Main Admins can schedule lead meetings.", 403)
        lead = db.session.get(Lead, int(lead_id)) if str(lead_id).isdigit() else None
        if not lead:
            return error("Lead not found.", 404)
        if user.role.name == "SALES_MANAGER" and not sales_manager_can_access_lead(user, lead):
            return error("This lead is not available in your sales pipeline.", 403)
        if lead.approval_status != "APPROVED":
            return error("Main Admin approval is required before scheduling a lead meeting.", 409)

    try:
        starts_at = parse_datetime(data.get("starts_at"))
    except (TypeError, ValueError):
        return error("starts_at must be a future ISO 8601 datetime with timezone.")
    try:
        duration = int(data.get("duration_minutes", 30))
    except (ValueError, TypeError):
        return error("duration_minutes must be an integer.")
    if duration < 5 or duration > 480:
        return error("duration_minutes must be between 5 and 480.")
    target_key = f"ticket:{ticket.id}" if ticket else f"lead:{lead.id}"
    request_key = hashlib.sha256(
        f"{target_key}:{starts_at.isoformat()}".encode("utf-8")
    ).hexdigest()
    existing_query = Meeting.query.filter_by(starts_at=starts_at)
    existing_query = existing_query.filter_by(
        ticket_id=ticket.id if ticket else None,
        lead_id=lead.id if lead else None,
    )
    existing_meeting = existing_query.order_by(Meeting.id).first()
    if existing_meeting:
        return jsonify({
            "meeting": existing_meeting.to_dict(),
            "email_sent": False,
            "created": False,
        }), 200
    meeting = Meeting(
        ticket_id=ticket.id if ticket else None,
        lead_id=lead.id if lead else None,
        request_key=request_key,
        starts_at=starts_at,
        duration_minutes=duration,
        jitsi_url=(
            f"https://meet.jit.si/{ticket.ticket_number}"
            if ticket
            else f"https://meet.jit.si/NexusCRM-Lead-{lead.id}-{request_key[:12]}"
        ),
        created_by_id=user.id,
    )
    db.session.add(meeting)
    try:
        db.session.flush()
    except IntegrityError:
        db.session.rollback()
        existing_meeting = Meeting.query.filter_by(request_key=request_key).first()
        if existing_meeting:
            return jsonify({
                "meeting": existing_meeting.to_dict(),
                "email_sent": False,
                "created": False,
            }), 200
        raise
    if ticket:
        ticket.status = "MEETING_SCHEDULED"
        ticket.updated_at = utcnow()
        record_action(user, "SCHEDULE_MEETING", "Meeting", meeting.id, f"Meeting scheduled for {ticket.ticket_number}.")
        notify_ticket_parties(ticket, "MEETING_SCHEDULED", "Meeting scheduled",
                              f"{ticket.ticket_number}: {starts_at.isoformat()} — {meeting.jitsi_url}")
    else:
        record_action(user, "SCHEDULE_MEETING", "Meeting", meeting.id, f"Meeting scheduled for lead {lead.id}.")
        if lead.customer:
            notify_user(
                lead.customer,
                "MEETING_SCHEDULED",
                "Meeting scheduled",
                f"{starts_at.isoformat()} — {meeting.jitsi_url}",
                link="/meetings",
                idempotency_key=f"meeting:{request_key}:customer:{lead.customer.id}",
            )
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        existing_meeting = Meeting.query.filter_by(request_key=request_key).first()
        if existing_meeting:
            return jsonify({
                "meeting": existing_meeting.to_dict(),
                "email_sent": False,
                "created": False,
            }), 200
        raise
    if ticket:
        email_sent = send_ticket_email(
            ticket, "Meeting scheduled", meeting.jitsi_url
        )
        from .realtime import emit_to_department, emit_to_user
        emit_to_department(ticket.department_id, "meeting_scheduled", meeting.to_dict())
        emit_to_user(ticket.customer_id, "meeting_scheduled", meeting.to_dict())
    else:
        email_sent = queue_crm_email(
            current_app._get_current_object(),
            lead.email,
            "Meeting scheduled – Nexus CRM",
            (
                f"Hello {lead.contact_name},\n\n"
                f"A meeting has been scheduled for {starts_at.isoformat()} "
                f"({duration} minutes).\n"
                f"Join the meeting: {meeting.jitsi_url}\n\n"
                "This is an automated notification from Nexus CRM."
            ),
        )
    return jsonify({"meeting": meeting.to_dict(), "email_sent": email_sent, "created": True}), 201


SUPPORT_LEAD_ROLES = {"SUPPORT"}
LEAD_OPERATIONAL_STATUSES = {
    "NEW", "UNDER_REVIEW", "CONTACTED", "INTERESTED", "QUALIFIED",
    "PURCHASE_PENDING", "CONVERTED", "LOST", "DISQUALIFIED",
}
LEAD_APPROVAL_STATUSES = {
    "NOT_SUBMITTED", "PENDING_APPROVAL", "NEEDS_INFORMATION", "REJECTED", "APPROVED",
}


def lead_dedupe_key(email):
    return hashlib.sha256(email.strip().lower().encode("utf-8")).hexdigest()


def lead_is_active(status):
    return status not in {"CONVERTED", "LOST", "DISQUALIFIED"}


def support_lead_assignee():
    support_role = Role.query.filter_by(name="SUPPORT").first()
    if not support_role:
        return None
    candidates = User.query.filter_by(role_id=support_role.id, is_active=True).all()
    if not candidates:
        return None
    counts = dict(
        db.session.query(Lead.support_assigned_to_id, func.count(Lead.id))
        .filter(Lead.support_assigned_to_id.in_([candidate.id for candidate in candidates]))
        .filter(Lead.approval_status.notin_(["APPROVED"]))
        .group_by(Lead.support_assigned_to_id)
        .all()
    )
    return min(candidates, key=lambda candidate: (counts.get(candidate.id, 0), candidate.id))


def notify_lead_support(lead, title="New lead needs support review"):
    from .realtime import emit_to_user

    recipients = [lead.support_assigned_to] if lead.support_assigned_to else (
        User.query.join(Role).filter(Role.name.in_(SUPPORT_LEAD_ROLES), User.is_active.is_(True)).all()
    )
    notices = []
    for recipient in recipients:
        notification = notify_user(
            recipient,
            "LEAD_REVIEW",
            title,
            f"{lead.contact_name} · {lead.product.name if lead.product else 'Product enquiry'}",
            link=f"/lead-review?lead={lead.id}",
            idempotency_key=f"lead:{lead.id}:support:{lead.created_at.isoformat()}:{recipient.id}",
        )
        if notification:
            emit_to_user(recipient.id, "lead_updated", {"id": lead.id})
            notices.append((recipient, notification))
    return notices


def notify_lead_sales(lead, enquiry):
    from .realtime import emit_to_user

    sales_managers = User.query.join(Role).filter(
        Role.name == "SALES_MANAGER",
        User.is_active.is_(True),
    ).all()
    for manager in sales_managers:
        notification = notify_user(
            manager,
            "LEAD_ASSIGNED",
            "New sales enquiry assigned to you",
            (
                f"{lead.contact_name} · {lead.product.name if lead.product else 'Product enquiry'}\n"
                f"{enquiry.message}"
            ),
            link=f"/leads?origin=customer&enquiry={enquiry.id}",
            idempotency_key=f"enquiry:{enquiry.id}:sales:{manager.id}",
        )
        if notification:
            emit_to_user(manager.id, "lead_updated", {"id": lead.id})


def sales_manager_can_access_lead(user, lead):
    if lead.assigned_to_id == user.id:
        return True
    if lead.customer_id is not None:
        return True
    if lead.created_by and lead.created_by.role.name == "CUSTOMER":
        return True
    if db.session.query(Enquiry.id).filter_by(
        lead_id=lead.id,
        type="SALES_ENQUIRY",
    ).first():
        return True
    if db.session.query(ProductInterestEvent.id).filter_by(lead_id=lead.id).first():
        return True
    return False


def customer_generated_sales_lead_filter():
    return or_(
        Lead.customer_id.is_not(None),
        Lead.created_by.has(User.role.has(Role.name == "CUSTOMER")),
        Lead.enquiries.any(Enquiry.type == "SALES_ENQUIRY"),
        Lead.interest_events.any(),
    )


def notify_sales_managers_of_product_interest(lead):
    from .realtime import emit_to_user

    managers = User.query.join(Role).filter(
        Role.name == "SALES_MANAGER",
        User.is_active.is_(True),
    ).all()
    for manager in managers:
        notification = notify_user(
            manager,
            "LEAD_ASSIGNED",
            "New product-interest lead added to your pipeline",
            f"{lead.contact_name} · {lead.product.name if lead.product else 'Product enquiry'}",
            link=f"/leads?origin=customer&lead={lead.id}",
            idempotency_key=f"product-interest:lead:{lead.id}:sales:{manager.id}",
        )
        if notification:
            emit_to_user(manager.id, "lead_updated", {"id": lead.id})


def notify_lead_admins(lead, title, body, idempotency_key):
    notices = []
    for admin in User.query.join(Role).filter(Role.name == "MAIN_ADMIN", User.is_active.is_(True)).all():
        notification = notify_user(
            admin,
            "LEAD_APPROVAL",
            title,
            body,
            link=f"/lead-review?lead={lead.id}",
            idempotency_key=f"{idempotency_key}:{admin.id}",
        )
        if notification:
            notices.append((admin, notification))
    return notices


def queue_lead_notification_emails(notices):
    app = current_app._get_current_object()
    for recipient, notification in notices:
        queue_crm_email(
            app,
            recipient.email,
            notification.title,
            f"{notification.body}\n\nOpen the CRM: {app.config['FRONTEND_URL']}{notification.link}",
        )


def overdue_lead_notifications(user):
    if user.role.name not in SUPPORT_LEAD_ROLES | {"SALES_MANAGER"}:
        return []
    now = utcnow()
    query = Lead.query.filter(
        Lead.follow_up_at.is_not(None),
        Lead.follow_up_at <= now,
        Lead.status.notin_(["CONVERTED", "LOST"]),
    )
    if user.role.name == "SALES_MANAGER":
        query = query.filter(
            Lead.approval_status == "APPROVED",
            Lead.assigned_to_id == user.id,
        )
    else:
        query = query.filter(
            Lead.approval_status.notin_(["APPROVED", "PENDING_APPROVAL"]),
            or_(Lead.support_assigned_to_id == user.id, Lead.support_assigned_to_id.is_(None)),
        )
    notices = []
    for lead in query.order_by(Lead.follow_up_at, Lead.id).limit(100):
        due_key = lead.follow_up_at.isoformat()
        notification = notify_user(
            user,
            "LEAD_FOLLOW_UP_OVERDUE",
            "Lead follow-up is overdue",
            f"Follow up with {lead.contact_name} about {lead.product.name if lead.product else 'the enquiry'}.",
            link=f"/lead-review?lead={lead.id}" if user.role.name in SUPPORT_LEAD_ROLES else f"/leads?lead={lead.id}",
            idempotency_key=f"lead:{lead.id}:follow-up-overdue:{due_key}:{user.id}",
        )
        if notification:
            notices.append((user, notification))
    return notices


def can_support_access_lead(user, lead):
    return user.role.name in SUPPORT_LEAD_ROLES and (
        lead.support_assigned_to_id is None or lead.support_assigned_to_id == user.id
    )


@api.get("/leads/support")
@api.get("/leads/support/")
@api.get("/support/leads")
@authenticated
def support_lead_queue(user):
    if user.role.name not in SUPPORT_LEAD_ROLES:
        return error("Support staff access is required.", 403)
    query = Lead.query
    if user.role.name != "MAIN_ADMIN":
        query = query.filter(or_(
            Lead.support_assigned_to_id == user.id,
            Lead.support_assigned_to_id.is_(None),
        ))
    approval_status = request.args.get("approval_status", "").upper()
    if approval_status:
        if approval_status not in LEAD_APPROVAL_STATUSES:
            return error("Unsupported approval status.")
        query = query.filter_by(approval_status=approval_status)
    status = request.args.get("status", "").upper()
    if status:
        if status not in LEAD_OPERATIONAL_STATUSES:
            return error("Unsupported lead status.")
        query = query.filter_by(status=status)
    search = request.args.get("search", "").strip()[:120]
    if search:
        term = f"%{search}%"
        query = query.filter(or_(
            Lead.contact_name.ilike(term),
            Lead.email.ilike(term),
            Lead.company.ilike(term),
            Lead.source.ilike(term),
        ))
    try:
        page = max(1, int(request.args.get("page", "1")))
        per_page = min(100, max(1, int(request.args.get("per_page", "25"))))
    except ValueError:
        return error("page and per_page must be integers.")
    results = query.order_by(Lead.updated_at.desc(), Lead.id.desc()).paginate(
        page=page, per_page=per_page, error_out=False,
    )
    return jsonify({
        "results": [lead.to_dict(include_review=True) for lead in results.items],
        "total": results.total,
        "page": results.page,
        "pages": results.pages,
    })


@api.get("/leads/support/<int:lead_id>")
@api.get("/support/leads/<int:lead_id>")
@authenticated
def support_lead_detail(user, lead_id):
    if user.role.name not in SUPPORT_LEAD_ROLES:
        return error("Support staff access is required.", 403)
    lead = db.session.get(Lead, lead_id)
    if not lead:
        return error("Lead not found.", 404)
    if not can_support_access_lead(user, lead):
        return error("This lead is assigned to another support employee.", 403)
    return jsonify(lead.to_dict(include_review=True))


@api.get("/support/product-interests")
@authenticated
def support_product_interest_queue(user):
    if user.role.name not in SUPPORT_LEAD_ROLES:
        return error("Support staff access is required.", 403)
    query = ProductInterestEvent.query.filter(ProductInterestEvent.lead_id.is_(None))
    search = request.args.get("search", "").strip()[:120]
    if search:
        query = query.join(Product).filter(Product.name.ilike(f"%{search}%"))
    try:
        page = max(1, int(request.args.get("page", "1")))
        per_page = min(100, max(1, int(request.args.get("per_page", "25"))))
    except ValueError:
        return error("page and per_page must be integers.")
    result = query.order_by(ProductInterestEvent.last_seen_at.desc(), ProductInterestEvent.id.desc()).paginate(
        page=page, per_page=per_page, error_out=False,
    )
    return jsonify({
        "results": [{
            "id": event.id,
            "product_id": event.product_id,
            "product_name": event.product.name if event.product else None,
            "first_seen_at": event.first_seen_at.isoformat(),
            "last_seen_at": event.last_seen_at.isoformat(),
            "visit_count": event.visit_count,
        } for event in result.items],
        "total": result.total,
        "page": result.page,
        "pages": result.pages,
    })


@api.patch("/leads/support/<int:lead_id>")
@api.patch("/support/leads/<int:lead_id>")
@authenticated
def update_support_lead(user, lead_id):
    if user.role.name not in SUPPORT_LEAD_ROLES:
        return error("Support staff access is required.", 403)
    lead = db.session.get(Lead, lead_id)
    if not lead:
        return error("Lead not found.", 404)
    if not can_support_access_lead(user, lead):
        return error("This lead is assigned to another support employee.", 403)
    if lead.approval_status not in {"NOT_SUBMITTED", "NEEDS_INFORMATION", "REJECTED"}:
        return error("Only leads requiring support verification or correction can be edited.", 409)
    data = request.get_json(silent=True) or {}
    allowed = {"contact_name", "email", "phone", "company", "product_id", "notes",
               "customer_requirements", "support_verification_notes", "customer_interest_status",
               "purchase_intent", "follow_up_at"}
    if set(data) - allowed:
        return error("The request contains fields support staff cannot change.")
    name = str(data.get("contact_name", lead.contact_name)).strip()
    email = str(data.get("email", lead.email)).strip().lower()
    phone = str(data.get("phone", lead.phone)).strip()
    company = str(data.get("company", lead.company)).strip()
    if not name or len(name) > 160 or len(email) > 254 or len(phone) > 40 or len(company) > 180:
        return error("Name is required; email, phone, and company must fit their limits.")
    if email:
        try:
            email = validate_email(email, check_deliverability=False).normalized.lower()
        except EmailNotValidError:
            return error("Enter a valid email address.")
    if not email and not phone:
        return error("A valid email address or phone number is required.")
    product_id = data.get("product_id", lead.product_id)
    product = db.session.get(Product, product_id) if type(product_id) is int else None
    if not product or product.status != "ACTIVE":
        return error("Choose an active product.")
    interest_status = str(data.get("customer_interest_status", lead.customer_interest_status)).upper()
    if interest_status not in {"INTERESTED", "NOT_INTERESTED", "AWAITING_RESPONSE"}:
        return error("Choose INTERESTED, NOT_INTERESTED, or AWAITING_RESPONSE.")
    purchase_intent = str(data.get("purchase_intent", lead.purchase_intent)).upper()
    if purchase_intent not in {"YES", "NO", "UNKNOWN"}:
        return error("Choose YES, NO, or UNKNOWN for purchase intent.")
    if lead.purchase_verified_at and purchase_intent != lead.purchase_intent:
        return error("Purchase intent cannot be changed after purchase verification.", 409)
    requirements = str(data.get("customer_requirements", lead.customer_requirements)).strip()
    verification_notes = str(data.get("support_verification_notes", lead.support_verification_notes)).strip()
    notes = str(data.get("notes", lead.notes)).strip()
    if len(requirements) > 5000 or len(verification_notes) > 5000 or len(notes) > 5000:
        return error("Requirements, verification notes, and notes cannot exceed 5000 characters.")
    follow_up_at = lead.follow_up_at
    if "follow_up_at" in data:
        try:
            follow_up_at = parse_datetime(data["follow_up_at"]) if data["follow_up_at"] else None
        except (TypeError, ValueError):
            return error("follow_up_at must be a valid ISO 8601 timestamp.")
    lead.contact_name = name
    lead.email = email
    lead.phone = phone
    lead.company = company
    lead.product = product
    lead.customer_requirements = requirements
    lead.support_verification_notes = verification_notes
    lead.customer_interest_status = interest_status
    lead.purchase_intent = purchase_intent
    lead.notes = notes
    lead.follow_up_at = follow_up_at
    lead.status = "INTERESTED" if interest_status == "INTERESTED" else (
        "CONTACTED" if interest_status == "AWAITING_RESPONSE" else "LOST"
    )
    lead.dedupe_key = lead_dedupe_key(email) if email and lead_is_active(lead.status) else None
    if lead.support_assigned_to_id is None:
        lead.support_assigned_to = user
    db.session.add(LeadApprovalHistory(lead=lead, actor=user, action="SUPPORT_UPDATED"))
    record_action(user, "UPDATE", "Lead", lead.id, f"Support verification updated for lead {lead.id}.")
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return error("Another active lead already exists for this email address.", 409)
    except SQLAlchemyError:
        db.session.rollback()
        logger.exception("Database error while saving support verification for lead %s.", lead_id)
        return error("The support verification could not be saved.", 500)
    return jsonify(lead.to_dict(include_review=True))


def lead_submission_errors(lead):
    missing = []
    if not lead.contact_name.strip():
        missing.append("Customer name")
    if not lead.email and not lead.phone:
        missing.append("Valid email or phone")
    if not lead.product_id:
        missing.append("Interested product")
    if not lead.source.strip():
        missing.append("Lead source")
    if not lead.customer_requirements.strip():
        missing.append("Customer requirements or enquiry summary")
    if not lead.support_verification_notes.strip():
        missing.append("Support verification notes")
    if lead.customer_interest_status not in {"INTERESTED", "NOT_INTERESTED", "AWAITING_RESPONSE"}:
        missing.append("Customer communication status")
    return missing


@api.post("/leads/support/<int:lead_id>/submit")
@api.post("/support/leads/<int:lead_id>/submit")
@authenticated
def submit_lead_for_approval(user, lead_id):
    if user.role.name not in SUPPORT_LEAD_ROLES:
        return error("Support staff access is required.", 403)
    lead = db.session.get(Lead, lead_id)
    if not lead:
        return error("Lead not found.", 404)
    if not can_support_access_lead(user, lead):
        return error("This lead is assigned to another support employee.", 403)
    if lead.approval_status not in {"NOT_SUBMITTED", "NEEDS_INFORMATION", "REJECTED"}:
        return error("This lead has already been submitted for approval.", 409)
    missing = lead_submission_errors(lead)
    if missing:
        return error("Complete the required lead verification fields before submission.", 400, missing_fields=missing)
    resubmission = lead.approval_status in {"NEEDS_INFORMATION", "REJECTED"}
    now = utcnow()
    lead.approval_status = "PENDING_APPROVAL"
    lead.status = "UNDER_REVIEW"
    lead.support_verified_by = user
    lead.support_verified_at = now
    lead.submitted_for_approval_at = now
    lead.rejection_reason = ""
    lead.review_comment = ""
    if resubmission:
        lead.resubmission_count += 1
    action = "RESUBMITTED" if resubmission else "SUBMITTED"
    db.session.add(LeadApprovalHistory(lead=lead, actor=user, action=action))
    record_action(user, action, "Lead", lead.id, f"Lead {lead.id} submitted for Main Admin approval.")
    lead_notifications = notify_lead_admins(
        lead,
        "Lead submitted for approval",
        f"{lead.contact_name} is ready for review.",
        f"lead:{lead.id}:submitted:{now.isoformat()}",
    )
    db.session.commit()
    queue_lead_notification_emails(lead_notifications)
    return jsonify(lead.to_dict(include_review=True)), 200


@api.post("/leads/support/<int:lead_id>/contact")
@api.post("/support/leads/<int:lead_id>/contact")
@authenticated
def contact_lead_by_email(user, lead_id):
    if user.role.name not in SUPPORT_LEAD_ROLES:
        return error("Support staff access is required.", 403)
    lead = db.session.get(Lead, lead_id)
    if not lead:
        return error("Lead not found.", 404)
    if not can_support_access_lead(user, lead):
        return error("This lead is assigned to another support employee.", 403)
    if not lead.email:
        return error("Add and verify a customer email address before sending email.", 409)
    data = request.get_json(silent=True) or {}
    subject = str(data.get("subject", "")).strip()
    body = str(data.get("body", "")).strip()
    if not subject or len(subject) > 240 or not body or len(body) > 10000:
        return error("An email subject (max 240 characters) and message (max 10,000 characters) are required.")
    communication = LeadCommunication(
        lead=lead,
        sender=user,
        recipient=lead.email,
        subject=subject,
        body=body,
        delivery_status="QUEUED",
    )
    db.session.add(communication)
    db.session.add(LeadApprovalHistory(lead=lead, actor=user, action="CUSTOMER_EMAIL_QUEUED", comment=subject))
    record_action(user, "EMAIL_QUEUED", "Lead", lead.id, f"Customer contact email queued for lead {lead.id}.")
    db.session.commit()
    queue_lead_email(current_app._get_current_object(), communication.id)
    return jsonify({
        "communication": communication.to_dict(),
        "message": "Email queued for delivery. Its SMTP status will update asynchronously.",
    }), 202


@api.get("/leads/approvals")
@api.get("/leads/approvals/")
@api.get("/admin/lead-approvals")
@authenticated
def admin_lead_approval_queue(user):
    if user.role.name != "MAIN_ADMIN":
        return error("Main Admin access is required.", 403)
    approval_status = request.args.get("approval_status", "PENDING_APPROVAL").upper()
    if approval_status not in LEAD_APPROVAL_STATUSES:
        return error("Unsupported approval status.")
    query = Lead.query.filter_by(approval_status=approval_status)
    search = request.args.get("search", "").strip()[:120]
    if search:
        term = f"%{search}%"
        query = query.filter(or_(Lead.contact_name.ilike(term), Lead.email.ilike(term), Lead.company.ilike(term)))
    try:
        page = max(1, int(request.args.get("page", "1")))
        per_page = min(100, max(1, int(request.args.get("per_page", "25"))))
    except ValueError:
        return error("page and per_page must be integers.")
    results = query.order_by(Lead.submitted_for_approval_at.desc(), Lead.id.desc()).paginate(
        page=page, per_page=per_page, error_out=False,
    )
    return jsonify({
        "results": [lead.to_dict(include_review=True) for lead in results.items],
        "total": results.total,
        "page": results.page,
        "pages": results.pages,
    })


@api.post("/leads/<int:lead_id>/review")
@api.post("/admin/leads/<int:lead_id>/review")
@authenticated
def review_lead_approval(user, lead_id):
    if user.role.name != "MAIN_ADMIN":
        return error("Only the Main Admin can approve or reject leads.", 403)
    lead = db.session.get(Lead, lead_id)
    if not lead:
        return error("Lead not found.", 404)
    if lead.approval_status != "PENDING_APPROVAL":
        return error("Only pending submissions can be reviewed.", 409)
    if lead.support_verified_by_id == user.id:
        return error("The submitting employee cannot approve their own submission.", 403)
    data = request.get_json(silent=True) or {}
    action = str(data.get("action", "")).upper()
    comment = str(data.get("comment", "")).strip()
    if action not in {"APPROVE", "REJECT", "NEEDS_INFORMATION"}:
        return error("Choose APPROVE, REJECT, or NEEDS_INFORMATION.")
    if action in {"REJECT", "NEEDS_INFORMATION"} and not comment:
        return error("A reason is required when rejecting or requesting more information.")
    if len(comment) > 5000:
        return error("Review comments cannot exceed 5000 characters.")
    now = utcnow()
    lead.review_comment = comment
    if action == "APPROVE":
        lead.approval_status = "APPROVED"
        lead.approved_by = user
        lead.approved_at = now
        lead.status = "QUALIFIED"
        lead.rejection_reason = ""
        notification_title = "Lead approved"
        history_action = "APPROVED"
    elif action == "REJECT":
        lead.approval_status = "REJECTED"
        lead.approved_by = None
        lead.approved_at = None
        lead.rejection_reason = comment
        notification_title = "Lead returned for correction"
        history_action = "REJECTED"
    else:
        lead.approval_status = "NEEDS_INFORMATION"
        lead.approved_by = None
        lead.approved_at = None
        lead.rejection_reason = ""
        notification_title = "More lead information requested"
        history_action = "NEEDS_INFORMATION"
    db.session.add(LeadApprovalHistory(lead=lead, actor=user, action=history_action, comment=comment))
    record_action(user, history_action, "Lead", lead.id, f"Lead approval review: {history_action}.", {"comment": comment})
    notices = []
    recipients = {
        recipient.id: (
            recipient,
            f"/leads?lead={lead.id}" if recipient.role.name == "SALES_MANAGER"
            else f"/lead-review?lead={lead.id}",
        )
        for recipient in (
            lead.support_assigned_to,
            lead.support_verified_by,
        ) if recipient
    }
    if lead.assigned_to:
        recipients[lead.assigned_to.id] = (lead.assigned_to, f"/leads?lead={lead.id}")
    for manager in User.query.join(Role).filter(
        Role.name == "SALES_MANAGER",
        User.is_active.is_(True),
    ).all():
        if sales_manager_can_access_lead(manager, lead):
            recipients[manager.id] = (manager, f"/leads?lead={lead.id}")
    for recipient, link in recipients.values():
        notification = notify_user(
            recipient,
            "LEAD_APPROVAL_RESULT",
            notification_title,
            comment or f"{lead.contact_name} was approved for sales follow-up.",
            link=link,
            idempotency_key=f"lead:{lead.id}:review:{now.isoformat()}:{action}:{recipient.id}",
        )
        if notification:
            notices.append((recipient, notification))
    db.session.commit()
    queue_lead_notification_emails(notices)
    return jsonify(lead.to_dict(include_review=True))


@api.get("/leads/<int:lead_id>/history")
@authenticated
def lead_approval_history(user, lead_id):
    lead = db.session.get(Lead, lead_id)
    if not lead:
        return error("Lead not found.", 404)
    authorized = (
        user.role.name == "MAIN_ADMIN"
        or (user.role.name in SUPPORT_LEAD_ROLES and can_support_access_lead(user, lead))
        or (user.role.name == "SALES_MANAGER" and sales_manager_can_access_lead(user, lead))
    )
    if not authorized:
        return error("You cannot view this lead's history.", 403)
    return jsonify([entry.to_dict() for entry in lead.approval_history])


@api.get("/leads/<int:lead_id>/enquiries")
@authenticated
def lead_enquiry_history(user, lead_id):
    lead = db.session.get(Lead, lead_id)
    if not lead:
        return error("Lead not found.", 404)
    authorized = (
        user.role.name == "MAIN_ADMIN"
        or (user.role.name in SUPPORT_LEAD_ROLES and can_support_access_lead(user, lead))
        or (
            user.role.name == "SALES_MANAGER"
            and sales_manager_can_access_lead(user, lead)
        )
    )
    if not authorized:
        return error("You cannot view this lead's enquiries.", 403)
    return jsonify([enquiry.to_dict() for enquiry in lead.enquiries])


@api.get("/leads/<int:lead_id>")
@authenticated
def get_sales_lead(user, lead_id):
    if user.role.name not in {"SALES_MANAGER", "MAIN_ADMIN"}:
        return error("Sales Manager or Main Admin access is required.", 403)
    lead = db.session.get(Lead, lead_id)
    if not lead:
        return error("Lead not found.", 404)
    if user.role.name == "MAIN_ADMIN":
        return jsonify(lead.to_dict(include_review=True))
    if not sales_manager_can_access_lead(user, lead):
        return error("This lead is not available in your sales pipeline.", 403)
    return jsonify(lead.to_dict())


@api.post("/product-interests")
@api.post("/product-interests/")
@jwt_required(optional=True)
def record_product_interest():
    data = request.get_json(silent=True) or {}
    product_id = data.get("product_id")
    session_ref = str(data.get("session_ref", "")).strip()
    if type(product_id) is not int:
        return error("product_id must be an integer.")
    if len(session_ref) < 20 or len(session_ref) > 128:
        return error("A valid anonymous session reference is required.")
    product = db.session.get(Product, product_id)
    if not product or product.status != "ACTIVE":
        return error("Active product not found.", 404)
    visitor = current_user()
    customer = visitor if visitor and visitor.role.name == "CUSTOMER" else None
    session_hash = hashlib.sha256(
        f"{customer.id if customer else 'anonymous'}:{session_ref}".encode("utf-8")
    ).hexdigest()
    now = utcnow()
    event = ProductInterestEvent.query.filter_by(
        product_id=product.id,
        session_hash=session_hash,
    ).first()
    created_event = event is None
    if event:
        event.last_seen_at = now
        event.visit_count += 1
        if customer:
            event.customer_id = customer.id
    else:
        event = ProductInterestEvent(
            product=product,
            customer=customer,
            session_hash=session_hash,
            first_seen_at=now,
            last_seen_at=now,
            visit_count=1,
        )
        db.session.add(event)
        db.session.flush()

    lead = None
    lead_created = False
    lead_notifications = []
    if customer:
        key = lead_dedupe_key(customer.email)
        lead = Lead.query.filter_by(dedupe_key=key).with_for_update().first()
        if not lead:
            _, sales_assignee = route_ticket("PRODUCT_ENQUIRY", "MEDIUM")
            lead = Lead(
                contact_name=customer.name,
                email=customer.email,
                phone="",
                product=product,
                source="Product Interest",
                status="NEW",
                approval_status="NOT_SUBMITTED",
                assigned_to=sales_assignee,
                support_assigned_to=support_lead_assignee(),
                created_by=customer,
                customer=customer,
                dedupe_key=key,
            )
            try:
                with db.session.begin_nested():
                    db.session.add(lead)
                    db.session.flush()
            except IntegrityError:
                lead = Lead.query.filter_by(dedupe_key=key).with_for_update().first()
                if not lead:
                    db.session.rollback()
                    return error("A concurrent lead submission is being processed; retry this request.", 409)
            else:
                lead_created = True
                db.session.add(LeadApprovalHistory(
                    lead=lead,
                    actor=customer,
                    action="PRODUCT_INTEREST_RECORDED",
                    comment=f"Customer viewed {product.name}.",
                ))
                record_action(customer, "PRODUCT_INTEREST", "Lead", lead.id, f"Product interest recorded for {product.name}.")
                lead_notifications = notify_lead_support(lead)
                notify_sales_managers_of_product_interest(lead)
        else:
            lead_notifications = []
        lead.customer_id = customer.id
        event.lead = lead
    else:
        lead_notifications = []
    db.session.commit()
    queue_lead_notification_emails(lead_notifications)
    return jsonify({
        "event": event.to_dict(),
        "lead_created": lead_created,
        "lead": lead.to_dict() if lead else None,
    }), 201 if created_event else 200


@api.post("/leads/enquiry")
@api.post("/leads/enquiry/")
@api.post("/enquire")
@api.post("/enquire/")
@jwt_required(optional=True)
def create_website_enquiry():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return error("A JSON object is required.")
    visitor = current_user()
    if visitor and (not visitor.is_active or visitor.role.name != "CUSTOMER"):
        return error("Only customer accounts can submit enquiries while signed in.", 403)

    enquiry_type = str(data.get("type", data.get("enquiry_type", "sales_enquiry"))).strip().upper()
    if enquiry_type not in {"SALES_ENQUIRY", "SUPPORT_REQUEST"}:
        return error("type must be sales_enquiry or support_request.")
    message = str(data.get("message", data.get("customer_requirements", data.get("description", "")))).strip()
    if not message or len(message) > 20000:
        return error("A message (max 20,000 characters) is required.")

    product = None
    product_id = data.get("product_id")
    if product_id is not None:
        product = db.session.get(Product, product_id) if type(product_id) is int else None
        if not product or product.status != "ACTIVE":
            return error("Active product not found.", 404)

    if enquiry_type == "SUPPORT_REQUEST":
        if not visitor:
            return error("Sign in to submit a support request.", 401)
        category = str(data.get("issue_category", "TECHNICAL_SUPPORT")).upper()
        if category not in {"PRODUCT_DEFECT", "TECHNICAL_SUPPORT"}:
            return error("Support requests must use PRODUCT_DEFECT or TECHNICAL_SUPPORT.")
        subject = str(data.get("subject", "")).strip() or (
            f"Support request: {product.name}" if product else "Customer support request"
        )
        if len(subject) > 240:
            return error("subject cannot exceed 240 characters.")
        department, assignee = route_ticket(category, "MEDIUM")
        ticket = Ticket(
            ticket_number=create_ticket_number(),
            customer_id=visitor.id,
            product_id=product.id if product else None,
            issue_category=category,
            subject=subject,
            description=message,
            priority="MEDIUM",
            status="ASSIGNED" if assignee else "NEW",
            department_id=department.id,
            assignee_id=assignee.id if assignee else None,
        )
        db.session.add(ticket)
        db.session.flush()
        record_action(
            visitor, "CREATE", "Ticket", ticket.id,
            f"Created support request {ticket.ticket_number}.",
            {"category": category, "department": department.name},
        )
        notify_user(
            visitor, "TICKET_CREATED", "Support request created",
            f"{ticket.ticket_number} was created and routed to {department.name}.", ticket,
        )
        if assignee:
            notify_user(
                assignee, "TICKET_ASSIGNMENT", "Ticket assigned to you",
                f"{ticket.ticket_number}: {ticket.subject}", ticket,
            )
        try:
            db.session.commit()
        except IntegrityError:
            db.session.rollback()
            logger.exception("Could not persist support request for customer %s.", visitor.id)
            return error("The support request could not be saved. Please retry.", 409)
        except SQLAlchemyError:
            db.session.rollback()
            logger.exception("Database error while saving support request for customer %s.", visitor.id)
            return error("The support request could not be saved.", 500)
        email_sent = send_ticket_email(ticket, "Ticket created")
        if ticket.assignee:
            send_assignee_email(ticket, "New ticket assignment")
        from .realtime import emit_to_department, emit_to_user
        emit_to_department(department.id, "ticket_created", ticket.to_dict())
        emit_to_user(visitor.id, "ticket_created", ticket.to_dict())
        return jsonify({"type": "SUPPORT_REQUEST", "ticket": ticket.to_dict(), "email_sent": email_sent}), 201

    name = visitor.name if visitor else str(data.get("contact_name", data.get("name", ""))).strip()
    email = visitor.email if visitor else str(data.get("email", "")).strip().lower()
    phone = str(data.get("phone", "")).strip()
    company = str(data.get("company", "")).strip()
    source = str(data.get("source", "Website Enquiry" if not visitor else "Customer Enquiry")).strip()
    session_ref = str(data.get("session_ref", "")).strip()
    if not name or len(name) > 160 or len(email) > 254 or len(phone) > 40 or len(company) > 180:
        return error("A name and valid email are required; phone and company must fit their limits.")
    if not source or len(source) > 40:
        return error("source must contain between 1 and 40 characters.")
    try:
        email = validate_email(email, check_deliverability=False).normalized.lower()
    except EmailNotValidError:
        return error("Enter a valid email address.")
    if session_ref and not 20 <= len(session_ref) <= 128:
        return error("session_ref must be between 20 and 128 characters.")
    if not product:
        return error("Choose an active product.")

    key = lead_dedupe_key(email)
    lead = Lead.query.filter_by(dedupe_key=key).with_for_update().first()
    created = False
    lead_notifications = []
    if not lead:
        _, sales_assignee = route_ticket("PRODUCT_ENQUIRY", "MEDIUM")
        candidate = Lead(
            contact_name=name,
            email=email,
            company=company,
            phone=phone,
            product=product,
            source=source,
            customer_requirements=message,
            assigned_to=sales_assignee,
            support_assigned_to=support_lead_assignee(),
            created_by=visitor,
            customer=visitor,
            dedupe_key=key,
        )
        try:
            with db.session.begin_nested():
                db.session.add(candidate)
                db.session.flush()
            lead = candidate
            created = True
        except IntegrityError:
            lead = Lead.query.filter_by(dedupe_key=key).with_for_update().first()
            if not lead:
                db.session.rollback()
                return error("A concurrent submission is being processed; retry this enquiry.", 409)

    lead.product = product
    lead.customer_id = visitor.id if visitor else lead.customer_id
    if phone:
        lead.phone = phone
    if message and message not in lead.customer_requirements:
        lead.customer_requirements = "\n".join(
            part for part in (lead.customer_requirements.strip(), message) if part
        )[:5000]
    enquiry = Enquiry(
        lead=lead,
        customer=visitor,
        product=product,
        message=message,
        type="SALES_ENQUIRY",
    )
    db.session.add(enquiry)
    try:
        db.session.flush()
    except IntegrityError:
        db.session.rollback()
        return error("The enquiry conflicted with another database update; please retry.", 409)
    except SQLAlchemyError:
        db.session.rollback()
        logger.exception("Database error while recording sales enquiry for %s.", email)
        return error("The enquiry could not be saved.", 500)
    actor = visitor
    if created:
        db.session.add(LeadApprovalHistory(lead=lead, actor=actor, action="ENQUIRY_CREATED"))
        record_action(actor, "CREATE", "Lead", lead.id, f"Website enquiry created for {product.name}.")
    notify_lead_sales(lead, enquiry)
    record_action(actor, "CREATE", "Enquiry", enquiry.id, f"Sales enquiry recorded for lead {lead.id}.")
    if session_ref:
        session_owner = str(visitor.id) if visitor else "anonymous"
        session_hash = hashlib.sha256(f"{session_owner}:{session_ref}".encode("utf-8")).hexdigest()
        ProductInterestEvent.query.filter_by(
            product_id=product.id,
            session_hash=session_hash,
            lead_id=None,
        ).update({"lead_id": lead.id}, synchronize_session=False)
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        logger.exception("Could not persist sales enquiry for %s.", email)
        return error("The enquiry could not be saved because of a conflicting lead update.", 409)
    except SQLAlchemyError:
        db.session.rollback()
        logger.exception("Database error while saving sales enquiry for %s.", email)
        return error("The enquiry could not be saved.", 500)
    queue_lead_notification_emails(lead_notifications)
    confirmation_email_queued = False
    app = current_app._get_current_object()
    if created:
        confirmation_text, confirmation_html = sales_enquiry_email_content(
            name,
            "Thank you for your enquiry",
            f"Thank you for your interest in {product.name}. Our sales team has received your enquiry and will be in touch.",
            [("Product", product.name)],
            message,
        )
        confirmation_email_queued = queue_crm_email(
            app,
            email,
            f"Thank you for your enquiry about {product.name}",
            confirmation_text,
            html=confirmation_html,
        )
    if lead.assigned_to:
        assignment_text, assignment_html = sales_assignment_email_content(
            [
                ("Contact Name", lead.contact_name or "Not provided"),
                ("Email Address", lead.email or "Not provided"),
                ("Company Name", lead.company or "Not provided"),
                ("Phone Number", lead.phone or "Not provided"),
                ("Product", product.name),
            ],
            message,
            f"{app.config['FRONTEND_URL']}/leads",
        )
        queue_crm_email(
            app,
            lead.assigned_to.email,
            "New Sales Enquiry – Nexus CRM",
            assignment_text,
            html=assignment_html,
        )
    result = lead.to_dict()
    result["enquiry"] = enquiry.to_dict()
    result["lead_created"] = created
    result["confirmation_email_queued"] = confirmation_email_queued
    return jsonify(result), 201


@api.get("/leads")
@api.get("/leads/")
@authenticated
def list_leads(user):
    if user.role.name not in {"SALES_MANAGER", "MAIN_ADMIN"}:
        return error("Only sales managers and main admins can access the sales pipeline.", 403)
    query = Lead.query
    if user.role.name == "MAIN_ADMIN":
        pass
    else:
        query = query.filter(or_(
            Lead.assigned_to_id == user.id,
            customer_generated_sales_lead_filter(),
        ))
    status_counts_query = query
    origin = request.args.get("origin", "").strip().lower()
    if origin:
        if origin != "customer":
            return error("Unsupported lead origin.")
        query = query.filter(customer_generated_sales_lead_filter())
    status = request.args.get("status", "").upper()
    if status:
        if status not in LEAD_OPERATIONAL_STATUSES:
            return error("Unsupported lead status.")
        query = query.filter_by(status=status)
    approval_status = request.args.get("approval_status", "").upper()
    if approval_status:
        if approval_status not in LEAD_APPROVAL_STATUSES:
            return error("Unsupported approval status.")
        query = query.filter_by(approval_status=approval_status)
    search = request.args.get("search", "").strip()
    if search:
        term = f"%{search[:120]}%"
        query = query.filter(or_(
            Lead.contact_name.ilike(term),
            Lead.email.ilike(term),
            Lead.company.ilike(term),
        ))
    try:
        page = max(1, int(request.args.get("page", "1")))
        per_page = min(100, max(1, int(request.args.get("per_page", "50"))))
    except ValueError:
        return error("page and per_page must be integers.")
    pagination = query.order_by(Lead.created_at.desc()).paginate(
        page=page, per_page=per_page, error_out=False,
    )
    status_counts = {status: 0 for status in LEAD_OPERATIONAL_STATUSES}
    status_counts.update(dict(
        status_counts_query.with_entities(Lead.status, func.count(Lead.id))
        .group_by(Lead.status)
        .all()
    ))
    return jsonify({
        "results": [item.to_dict() for item in pagination.items],
        "total": pagination.total,
        "page": pagination.page,
        "pages": pagination.pages,
        "status_counts": status_counts,
    })


@api.get("/leads/enquiries")
@authenticated
def list_sales_enquiries(user):
    if user.role.name not in {"SALES_MANAGER", "MAIN_ADMIN"}:
        return error("Only sales managers and main admins can access customer enquiries.", 403)

    query = db.session.query(Lead, Enquiry).outerjoin(
        Enquiry,
        (Enquiry.lead_id == Lead.id) & (Enquiry.type == "SALES_ENQUIRY"),
    )
    query = query.filter(customer_generated_sales_lead_filter())
    if user.role.name != "MAIN_ADMIN":
        query = query.filter(or_(
            Lead.assigned_to_id == user.id,
            customer_generated_sales_lead_filter(),
        ))
    query = query.filter(or_(
        Enquiry.id.is_not(None),
        ~Lead.enquiries.any(Enquiry.type == "SALES_ENQUIRY"),
    ))
    search = request.args.get("search", "").strip()[:120]
    if search:
        term = f"%{search}%"
        query = query.filter(or_(
            Lead.contact_name.ilike(term),
            Lead.email.ilike(term),
            Lead.company.ilike(term),
            Enquiry.message.ilike(term),
        ))
    try:
        page = max(1, int(request.args.get("page", "1")))
        per_page = min(100, max(1, int(request.args.get("per_page", "50"))))
    except ValueError:
        return error("page and per_page must be integers.")

    pagination = query.order_by(
        Enquiry.created_at.desc(),
        Lead.created_at.desc(),
    ).paginate(page=page, per_page=per_page, error_out=False)
    results = []
    for lead, enquiry in pagination.items:
        results.append({
            "id": enquiry.id if enquiry else f"lead-{lead.id}",
            "enquiry_id": enquiry.id if enquiry else None,
            "lead_id": lead.id,
            "contact_name": lead.contact_name,
            "email": lead.email,
            "company": lead.company,
            "phone": lead.phone,
            "product": (
                {"id": enquiry.product.id, "name": enquiry.product.name}
                if enquiry and enquiry.product
                else {"id": lead.product.id, "name": lead.product.name}
                if lead.product
                else None
            ),
            "message": (
                enquiry.message if enquiry
                else lead.customer_requirements or "Customer showed interest in this product."
            ),
            "created_at": enquiry.created_at.isoformat() if enquiry else lead.created_at.isoformat(),
            "lead_status": lead.status,
            "approval_status": lead.approval_status,
            "lead": lead.to_dict(include_review=user.role.name == "MAIN_ADMIN"),
        })
    return jsonify({
        "results": results,
        "total": pagination.total,
        "page": pagination.page,
        "pages": pagination.pages,
    })


@api.post("/leads")
@api.post("/leads/")
@authenticated
def create_lead(user):
    if user.role.name not in {"SALES_MANAGER", "MAIN_ADMIN"}:
        return error("Sales Manager or Main Admin access is required.", 403)
    data = request.get_json(silent=True) or {}
    name = str(data.get("contact_name", "")).strip()
    email = str(data.get("email", "")).strip().lower()
    company = str(data.get("company", "")).strip()
    phone = str(data.get("phone", "")).strip()
    notes = str(data.get("notes", "")).strip()
    if not name or len(name) > 160 or len(company) > 180 or len(phone) > 40 or len(notes) > 5000:
        return error("Contact name is required; company, phone, and notes must fit their limits.")
    try:
        email = validate_email(email, check_deliverability=False).normalized.lower()
    except (EmailNotValidError, AttributeError):
        return error("Enter a valid email address.")
    key = lead_dedupe_key(email)
    if Lead.query.filter_by(dedupe_key=key).first():
        return error("An active lead already exists for this email address.", 409)
    product_id = data.get("product_id")
    product = db.session.get(Product, product_id) if type(product_id) is int else None
    if product_id is not None and (not product or product.status != "ACTIVE"):
        return error("Choose an active product.")
    if user.role.name == "SALES_MANAGER":
        assignee = user
    else:
        _, assignee = route_ticket("PRODUCT_ENQUIRY", "MEDIUM")
        if not assignee:
            return error("Create an active Sales Manager before adding leads.", 409)
    support_assignee = support_lead_assignee()
    lead = Lead(
        contact_name=name,
        email=email,
        company=company,
        phone=phone,
        product=product,
        notes=notes,
        source=str(data.get("source", "Website Enquiry")).strip()[:40] or "Website Enquiry",
        assigned_to=assignee,
        support_assigned_to=support_assignee,
        created_by=user,
        dedupe_key=key,
    )
    db.session.add(lead)
    try:
        db.session.flush()
    except IntegrityError:
        db.session.rollback()
        return error("An active lead already exists for this email address.", 409)
    except SQLAlchemyError:
        db.session.rollback()
        logger.exception("Database error while creating lead for %s.", email)
        return error("The lead could not be created.", 500)
    db.session.add(LeadApprovalHistory(lead=lead, actor=user, action="CREATED"))
    record_action(user, "CREATE", "Lead", lead.id, f"Created sales lead for {email}.")
    lead_notifications = notify_lead_support(lead)
    try:
        db.session.commit()
    except SQLAlchemyError:
        db.session.rollback()
        logger.exception("Database error while finishing lead creation for %s.", email)
        return error("The lead could not be created.", 500)
    queue_lead_notification_emails(lead_notifications)
    return jsonify(lead.to_dict()), 201


@api.post("/leads/<int:lead_id>/verify")
@authenticated
def verify_sales_lead(user, lead_id):
    if user.role.name != "SALES_MANAGER":
        return error("Sales Manager access is required to verify a lead.", 403)
    lead = db.session.get(Lead, lead_id)
    if not lead:
        return error("Lead not found.", 404)
    if not sales_manager_can_access_lead(user, lead):
        return error("This lead is not available in your sales pipeline.", 403)
    if lead.approval_status not in {"NOT_SUBMITTED", "NEEDS_INFORMATION", "REJECTED"}:
        return error("Only leads awaiting verification or correction can be submitted.", 409)
    data = request.get_json(silent=True) or {}
    verification_notes = str(data.get("verification_notes", "")).strip()
    if not verification_notes or len(verification_notes) > 5000:
        return error("Verification notes are required and cannot exceed 5000 characters.")
    if not lead.contact_name.strip() or not (lead.email.strip() or lead.phone.strip()):
        return error("A customer name and valid email address or phone number are required.")
    product_id = data.get("product_id", lead.product_id)
    product = db.session.get(Product, product_id) if type(product_id) is int else None
    if not product or product.status != "ACTIVE":
        return error("Choose an interested product before submitting the lead.")

    now = utcnow()
    resubmission = lead.approval_status in {"NEEDS_INFORMATION", "REJECTED"}
    lead.approval_status = "PENDING_APPROVAL"
    lead.product = product
    lead.support_verification_notes = verification_notes
    lead.support_verified_by = user
    lead.support_verified_at = now
    lead.submitted_for_approval_at = now
    lead.rejection_reason = ""
    lead.review_comment = ""
    if resubmission:
        lead.resubmission_count += 1
    action = "RESUBMITTED" if resubmission else "SALES_VERIFIED"
    db.session.add(LeadApprovalHistory(
        lead=lead,
        actor=user,
        action=action,
        comment=verification_notes,
    ))
    record_action(
        user,
        action,
        "Lead",
        lead.id,
        f"Sales Manager verified lead {lead.id} and submitted it for Main Admin approval.",
        {"verification_notes": verification_notes},
    )
    notices = notify_lead_admins(
        lead,
        "Sales lead ready for approval",
        f"{lead.contact_name} was verified by {user.name} and is ready for Main Admin review.",
        f"lead:{lead.id}:sales-submitted:{now.isoformat()}",
    )
    try:
        db.session.commit()
    except SQLAlchemyError:
        db.session.rollback()
        logger.exception("Database error while submitting lead %s for approval.", lead_id)
        return error("The verified lead could not be submitted for approval.", 500)
    queue_lead_notification_emails(notices)
    return jsonify(lead.to_dict()), 200


@api.patch("/leads/<int:lead_id>")
@authenticated
def update_lead(user, lead_id):
    if user.role.name not in {"SALES_MANAGER", "MAIN_ADMIN"}:
        return error("Sales Manager or Main Admin access is required.", 403)
    lead = db.session.get(Lead, lead_id)
    if not lead:
        return error("Lead not found.", 404)
    if user.role.name != "MAIN_ADMIN" and not sales_manager_can_access_lead(user, lead):
        return error("This lead is not available in your sales pipeline.", 403)
    if lead.status == "CONVERTED":
        return error("A converted lead cannot be changed.", 409)
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return error("A JSON object is required.")
    if lead.approval_status != "APPROVED" and set(data) != {"purchase_intent"}:
        return error("Sales follow-up is available only after Main Admin approval.", 409)
    status = lead.status
    if "status" in data:
        status = str(data["status"]).upper()
        if status not in {"NEW", "CONTACTED", "INTERESTED", "QUALIFIED", "PURCHASE_PENDING", "LOST", "DISQUALIFIED"}:
            return error("Choose a valid sales progress status; conversion uses the convert action.")
    purchase_intent = str(data.get("purchase_intent", lead.purchase_intent)).upper()
    if purchase_intent not in {"YES", "NO", "UNKNOWN"}:
        return error("Choose YES, NO, or UNKNOWN for purchase intent.")
    if lead.purchase_verified_at and purchase_intent != lead.purchase_intent:
        return error("Purchase intent cannot be changed after purchase verification.", 409)
    notes = str(data.get("notes", lead.notes)).strip()
    if len(notes) > 5000:
        return error("Lead notes cannot exceed 5000 characters.")
    lead.status = status
    lead.purchase_intent = purchase_intent
    lead.dedupe_key = lead_dedupe_key(lead.email) if lead_is_active(status) else None
    lead.notes = notes
    record_action(
        user,
        "UPDATE",
        "Lead",
        lead.id,
        f"Updated lead {lead.email} to {status}.",
        {"purchase_intent": purchase_intent},
    )
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return error("Another active lead already exists for this email address.", 409)
    except SQLAlchemyError:
        db.session.rollback()
        logger.exception("Database error while updating lead %s.", lead_id)
        return error("The lead could not be updated.", 500)
    return jsonify(lead.to_dict())


@api.post("/leads/<int:lead_id>/verify-purchase")
@authenticated
def verify_lead_purchase(user, lead_id):
    if user.role.name not in {"SALES_MANAGER", "MAIN_ADMIN"}:
        return error("Sales Manager or Main Admin access is required.", 403)
    lead = db.session.get(Lead, lead_id)
    if not lead:
        return error("Lead not found.", 404)
    if user.role.name != "MAIN_ADMIN" and not sales_manager_can_access_lead(user, lead):
        return error("This lead is not available in your sales pipeline.", 403)
    if lead.approval_status != "APPROVED":
        return error("Main Admin approval is required before purchase verification.", 409)
    if lead.purchase_verified_at:
        return error("This purchase has already been verified.", 409)
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return error("A JSON object is required.")
    purchase_intent = str(data.get("purchase_intent", lead.purchase_intent)).upper()
    if purchase_intent != "YES":
        return error("Confirm the customer's purchase intent as YES before verifying a purchase.", 409)
    notes = str(data.get("purchase_verification_notes", "")).strip()
    if len(notes) > 5000:
        return error("Purchase verification notes cannot exceed 5000 characters.")
    if not notes:
        notes = f"Purchase confirmed by {user.name} during lead conversion."
    lead.purchase_intent = "YES"
    lead.purchase_verified_by = user
    lead.purchase_verified_at = utcnow()
    lead.purchase_verification_notes = notes
    lead.status = "PURCHASE_PENDING"
    db.session.add(LeadApprovalHistory(lead=lead, actor=user, action="PURCHASE_VERIFIED", comment=notes))
    record_action(
        user,
        "PURCHASE_VERIFIED",
        "Lead",
        lead.id,
        f"Purchase verified for lead {lead.id}.",
        {"purchase_intent": "YES", "purchase_verification_notes": notes},
    )
    try:
        db.session.commit()
    except SQLAlchemyError:
        db.session.rollback()
        logger.exception("Database error while verifying purchase for lead %s.", lead_id)
        return error("The purchase verification could not be saved.", 500)
    return jsonify(lead.to_dict(include_review=True))


@api.post("/leads/<int:lead_id>/convert")
@authenticated
def convert_lead(user, lead_id):
    if user.role.name not in {"SALES_MANAGER", "MAIN_ADMIN"}:
        return error("Sales Manager or Main Admin access is required.", 403)
    lead = db.session.get(Lead, lead_id)
    if not lead:
        return error("Lead not found.", 404)
    if user.role.name != "MAIN_ADMIN" and not sales_manager_can_access_lead(user, lead):
        return error("This lead is not available in your sales pipeline.", 403)
    if lead.status == "CONVERTED":
        return error("This lead has already been converted.", 409)
    if lead.status in {"LOST", "DISQUALIFIED"}:
        return error("A lost lead cannot be converted.", 409)
    if lead.approval_status != "APPROVED":
        return error("Main Admin approval is required before a lead can be converted.", 409)
    if not lead.purchase_verified_at:
        return error("Verify the customer's purchase before converting this lead.", 409)
    customer = User.query.filter(func.lower(User.email) == lead.email).first()
    if customer and (customer.role.name != "CUSTOMER" or not customer.is_active):
        return error("The lead email is already used by a staff or inactive account.", 409)
    if not customer:
        customer = User(
            name=lead.contact_name,
            email=lead.email,
            role=get_role("CUSTOMER"),
            email_verified_at=utcnow(),
        )
        customer.set_password(secrets.token_urlsafe(32))
        db.session.add(customer)
        try:
            db.session.flush()
        except IntegrityError:
            db.session.rollback()
            return error("A customer account was created concurrently; retry the conversion.", 409)
        except SQLAlchemyError:
            db.session.rollback()
            logger.exception("Database error while creating a customer for lead %s.", lead_id)
            return error("The lead conversion could not be completed.", 500)
    elif customer.email_verified_at is None:
        customer.email_verified_at = utcnow()
    department, assignee = route_ticket("PRODUCT_ENQUIRY", "MEDIUM")
    if (
        lead.assigned_to
        and lead.assigned_to.is_active
        and lead.assigned_to.role.name == "SALES_MANAGER"
    ):
        assignee = lead.assigned_to
    description = lead.notes or f"Sales lead converted for {lead.contact_name}."
    if lead.company:
        description += f"\nCompany: {lead.company}"
    if lead.phone:
        description += f"\nPhone: {lead.phone}"
    ticket = Ticket(
        ticket_number=create_ticket_number(),
        customer=customer,
        product=lead.product,
        issue_category="PRODUCT_ENQUIRY",
        subject=f"Product enquiry: {lead.company or lead.contact_name}"[:240],
        description=description,
        priority="MEDIUM",
        status="ASSIGNED" if assignee else "NEW",
        department=department,
        assignee=assignee,
    )
    db.session.add(ticket)
    try:
        db.session.flush()
    except IntegrityError:
        db.session.rollback()
        return error("The conversion ticket conflicted with another database update; retry conversion.", 409)
    except SQLAlchemyError:
        db.session.rollback()
        logger.exception("Database error while creating conversion ticket for lead %s.", lead_id)
        return error("The lead conversion could not be completed.", 500)
    lead.status = "CONVERTED"
    lead.dedupe_key = None
    lead.customer_id = customer.id
    lead.converted_customer = customer
    lead.converted_ticket = ticket
    Enquiry.query.filter_by(lead_id=lead.id).update(
        {"customer_id": customer.id}, synchronize_session=False,
    )
    lead.updated_at = utcnow()
    notify_user(customer, "REGISTRATION", "Welcome to NEXUS CRM", "A customer account was created for your enquiry.")
    notify_ticket_parties(ticket, "TICKET_CREATED", "Product enquiry received", f"{ticket.ticket_number}: {ticket.subject}")
    record_action(user, "CONVERT", "Lead", lead.id, f"Converted lead {lead.email} to {ticket.ticket_number}.")
    record_action(user, "CREATE", "Ticket", ticket.ticket_number, f"Created from lead {lead.id}.")
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        logger.exception("Could not commit lead conversion for lead %s.", lead_id)
        return error("The lead conversion could not be completed. No changes were saved.", 409)
    except SQLAlchemyError:
        db.session.rollback()
        logger.exception("Database error while converting lead %s.", lead_id)
        return error("The lead conversion could not be completed. No changes were saved.", 500)
    customer_email_sent = send_ticket_email(
        ticket, "Product enquiry created"
    )
    assignee_email_sent = send_assignee_email(
        ticket, "New product enquiry"
    )
    from .realtime import emit_to_department
    emit_to_department(ticket.department_id, "ticket_created", ticket.to_dict())
    response = {
        "lead": lead.to_dict(),
        "ticket": ticket.to_dict(),
        "customer_email_sent": customer_email_sent,
        "assignee_email_sent": assignee_email_sent,
    }
    return jsonify(response), 201


@api.get("/meetings")
@api.get("/meetings/")
@authenticated
def list_meetings(user):
    query = Meeting.query.outerjoin(Ticket).outerjoin(Lead)
    if user.role.name == "CUSTOMER":
        query = query.filter(or_(
            Ticket.customer_id == user.id,
            Lead.customer_id == user.id,
        ))
    elif user.role.name == "SALES_MANAGER":
        accessible_lead_ids = db.session.query(Lead.id).filter(or_(
            Lead.assigned_to_id == user.id,
            customer_generated_sales_lead_filter(),
        )).subquery()
        query = query.filter(or_(
            and_(
                Meeting.ticket_id.is_not(None),
                or_(
                    Ticket.department_id == user.department_id,
                    Ticket.assignee_id == user.id,
                ),
            ),
            Meeting.lead_id.in_(accessible_lead_ids.select()),
        ))
    elif user.role.name == "MAIN_ADMIN":
        query = query.filter(Meeting.ticket_id.is_(None))
    else:
        query = query.filter(or_(Ticket.department_id == user.department_id, Ticket.assignee_id == user.id))
    lead_id = request.args.get("lead_id")
    if lead_id:
        if not lead_id.isdigit():
            return error("lead_id must be an integer.")
        query = query.filter(Meeting.lead_id == int(lead_id))
    if request.args.get("upcoming") == "true":
        query = query.filter(Meeting.starts_at >= utcnow())
    meetings = query.order_by(Meeting.starts_at).limit(500).all()
    return jsonify([meeting.to_dict() for meeting in meetings])


@api.get("/notifications")
@api.get("/notifications/")
@authenticated
def list_notifications(user):
    overdue_notices = overdue_lead_notifications(user)
    if overdue_notices:
        db.session.commit()
        queue_lead_notification_emails(overdue_notices)
    query = Notification.query.filter_by(recipient_id=user.id)
    unread_only = request.args.get("unread") == "true"
    if unread_only:
        query = query.filter(Notification.read_at.is_(None))
    items = query.order_by(Notification.created_at.desc()).limit(100).all()
    return jsonify([notification_payload(user, item) for item in items])


@api.post("/notifications/<int:notification_id>/read")
@authenticated
def mark_notification_read(user, notification_id):
    notification = db.session.get(Notification, notification_id)
    if not notification or notification.recipient_id != user.id:
        return error("Notification not found.", 404)
    notification.read_at = notification.read_at or utcnow()
    db.session.commit()
    return jsonify(notification_payload(user, notification))


@api.post("/notification/send")
@staff_required("MAIN_ADMIN")
def send_notification():
    data = request.get_json(silent=True) or {}
    recipient_id = data.get("recipient_id")
    recipient = db.session.get(User, int(recipient_id)) if str(recipient_id).isdigit() else None
    title = str(data.get("title", "")).strip()
    body = str(data.get("body", "")).strip()
    if not recipient or not title or len(title) > 180 or not body or len(body) > 10000:
        return error("Valid recipient_id, title, and body are required.")
    notification = notify_user(recipient, "ADMIN_MESSAGE", title, body)
    db.session.commit()
    email_sent = send_user_email(recipient.email, title, body)
    return jsonify({"notification": notification.to_dict(), "email_sent": email_sent}), 201


@api.get("/admin/dashboard")
@api.get("/admin/dashboard/")
@staff_required("MAIN_ADMIN")
def admin_dashboard():
    now = utcnow()
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    total_tickets = Ticket.query.count()
    open_tickets = Ticket.query.filter(Ticket.status.notin_(["RESOLVED", "CLOSED"])).count()
    closed_tickets = Ticket.query.filter_by(status="CLOSED").count()
    critical_tickets = Ticket.query.filter_by(priority="CRITICAL").filter(Ticket.status.notin_(["RESOLVED", "CLOSED"])).count()
    priority_rows = db.session.query(Ticket.priority, func.count(Ticket.id)).group_by(Ticket.priority).all()
    department_rows = db.session.query(Department.name, func.count(Ticket.id)).outerjoin(
        Ticket, Ticket.department_id == Department.id
    ).group_by(Department.id, Department.name).order_by(Department.name).all()
    month_format = "%Y-%m"
    month_expression = (
        func.strftime(month_format, Ticket.created_at)
        if db.engine.dialect.name == "sqlite"
        else func.to_char(Ticket.created_at, month_format)
    )
    trend_rows = db.session.query(
        month_expression.label("month"), func.count(Ticket.id)
    ).filter(Ticket.created_at >= now - timedelta(days=365)).group_by("month").order_by("month").all()
    meetings_total = Meeting.query.count()
    meetings_upcoming = Meeting.query.filter(Meeting.starts_at >= now).count()
    return jsonify({
        "total_users": User.query.count(),
        "total_customers": User.query.join(Role).filter(Role.name == "CUSTOMER").count(),
        "total_tickets": total_tickets,
        "open_tickets": open_tickets,
        "closed_tickets": closed_tickets,
        "critical_tickets": critical_tickets,
        "tickets_by_priority": {key: value for key, value in priority_rows},
        "tickets_by_department": {key: value for key, value in department_rows},
        "meetings": {"total": meetings_total, "upcoming": meetings_upcoming},
        "tickets_this_month": Ticket.query.filter(Ticket.created_at >= month_start).count(),
        "monthly_trends": [{"month": str(month), "tickets": count} for month, count in trend_rows],
        "workload_by_department": [
            {"department": name, "active_tickets": count}
            for name, count in db.session.query(Department.name, func.count(Ticket.id))
            .outerjoin(Ticket, Ticket.department_id == Department.id)
            .filter(or_(Ticket.id.is_(None), Ticket.status.notin_(["RESOLVED", "CLOSED"])))
            .group_by(Department.id, Department.name).all()
        ],
    })


@api.get("/admin/users")
@staff_required("MAIN_ADMIN")
def list_users():
    users = User.query.order_by(User.name).limit(1000).all()
    return jsonify([user.to_dict() for user in users])


@api.post("/admin/users")
@staff_required("MAIN_ADMIN")
def create_user():
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()
    email = str(data.get("email", "")).strip().lower()
    role_name = str(data.get("role", "")).upper()
    department_id = data.get("department_id")
    password = data.get("password")
    if not name or not isinstance(password, str) or len(password) < 12 or len(password) > 128:
        return error("Name and a password of 12–128 characters are required.")
    try:
        email = validate_email(email, check_deliverability=False).normalized.lower()
    except (EmailNotValidError, AttributeError):
        return error("Enter a valid email address.")
    role = Role.query.filter_by(name=role_name).first()
    if role is None or role_name == "MAIN_ADMIN":
        return error("Choose a valid non-admin role; main-admin creation is restricted.")
    if User.query.filter(func.lower(User.email) == email).first():
        return error("An account with that email already exists.", 409)
    department = db.session.get(Department, int(department_id)) if str(department_id).isdigit() else None
    if role_name != "CUSTOMER" and not department:
        return error("A department is required for staff accounts.")
    expected_slug = ROLE_DEPARTMENTS.get(role_name)
    if expected_slug and (not department or department.slug != expected_slug):
        return error(f"The {role_name.replace('_', ' ').title()} role must belong to {expected_slug}.")
    user = User(name=name, email=email, role=role, department=department, email_verified_at=utcnow())
    user.set_password(password)
    db.session.add(user)
    db.session.flush()
    record_action(current_user(), "CREATE", "User", user.id, f"Created user {email}.")
    db.session.commit()
    return jsonify(user.to_dict()), 201


@api.patch("/admin/users/<int:user_id>")
@staff_required("MAIN_ADMIN")
def update_user(user_id):
    actor = current_user()
    user = db.session.get(User, user_id)
    if not user:
        return error("User not found.", 404)
    data = request.get_json(silent=True) or {}
    if user.id == actor.id and data.get("is_active") is False:
        return error("You cannot deactivate your own account.")
    if "name" in data:
        name = str(data["name"]).strip()
        if not name or len(name) > 160:
            return error("Name must be 1–160 characters.")
        user.name = name
    if "is_active" in data:
        if not isinstance(data["is_active"], bool):
            return error("is_active must be a boolean.")
        user.is_active = data["is_active"]
    target_role = user.role
    if "role" in data:
        role = Role.query.filter_by(name=str(data["role"]).upper()).first()
        if not role or role.name == "MAIN_ADMIN" or user.id == actor.id:
            return error("Choose a valid role; you cannot change your own role.")
        target_role = role
    target_department = user.department
    if "department_id" in data:
        target_department = db.session.get(Department, data["department_id"]) if str(data["department_id"]).isdigit() else None
    if target_role.name != "CUSTOMER" and not target_department:
        return error("Staff users require a valid department.")
    expected_slug = ROLE_DEPARTMENTS.get(target_role.name)
    if expected_slug and (not target_department or target_department.slug != expected_slug):
        return error(f"The {target_role.name.replace('_', ' ').title()} role must belong to {expected_slug}.")
    user.role = target_role
    user.department = target_department
    record_action(actor, "UPDATE", "User", user.id, f"Updated user {user.email}.")
    db.session.commit()
    return jsonify(user.to_dict())


@api.delete("/admin/users/<int:user_id>")
@staff_required("MAIN_ADMIN")
def delete_user(user_id):
    actor = current_user()
    user = db.session.get(User, user_id)
    if not user:
        return error("User not found.", 404)
    if user.role.name == "MAIN_ADMIN":
        return error("Main administrator accounts cannot be deleted.", 403)
    if user.is_active:
        return error("Deactivate the account before deleting it.", 409)

    account_email = user.email
    try:
        db.session.query(Lead).filter(Lead.assigned_to_id == user.id).update(
            {Lead.assigned_to_id: None}, synchronize_session=False
        )
        db.session.query(Lead).filter(Lead.created_by_id == user.id).update(
            {Lead.created_by_id: None}, synchronize_session=False
        )
        db.session.query(Lead).filter(Lead.converted_customer_id == user.id).update(
            {Lead.converted_customer_id: None}, synchronize_session=False
        )
        db.session.query(Ticket).filter(Ticket.customer_id == user.id).update(
            {Ticket.customer_id: None}, synchronize_session=False
        )
        db.session.query(Ticket).filter(Ticket.assignee_id == user.id).update(
            {Ticket.assignee_id: None}, synchronize_session=False
        )
        db.session.query(TicketComment).filter(
            TicketComment.author_id == user.id
        ).update({TicketComment.author_id: None}, synchronize_session=False)
        db.session.query(TicketDocument).filter(
            TicketDocument.uploaded_by_id == user.id
        ).update({TicketDocument.uploaded_by_id: None}, synchronize_session=False)
        db.session.query(Meeting).filter(Meeting.created_by_id == user.id).update(
            {Meeting.created_by_id: None}, synchronize_session=False
        )
        db.session.query(ActivityLog).filter(ActivityLog.actor_id == user.id).update(
            {ActivityLog.actor_id: None}, synchronize_session=False
        )
        db.session.query(AuditLog).filter(AuditLog.actor_id == user.id).update(
            {AuditLog.actor_id: None}, synchronize_session=False
        )
        db.session.query(Notification).filter(
            Notification.recipient_id == user.id
        ).delete(synchronize_session=False)
        record_action(
            actor, "DELETE", "User", user.id,
            f"Deleted deactivated user account {account_email}.",
        )
        db.session.delete(user)
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        logger.exception("Database constraint prevented deletion of user %s.", user_id)
        return error(
            "The account could not be deleted because the database schema is outdated or still references this user. Apply the latest database migrations and retry.",
            409,
        )
    except SQLAlchemyError:
        db.session.rollback()
        logger.exception("Database error while deleting user %s.", user_id)
        return error("A database error prevented the account from being deleted.", 500)
    return jsonify({"deleted": True, "user_id": user_id})


@api.get("/admin/departments")
@staff_required("MAIN_ADMIN")
def list_departments():
    departments = Department.query.order_by(Department.name).all()
    return jsonify([{
        "id": item.id, "name": item.name, "slug": item.slug,
        "member_count": User.query.filter_by(department_id=item.id, is_active=True).count(),
    } for item in departments])


@api.post("/admin/departments")
@staff_required("MAIN_ADMIN")
def create_department():
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()
    slug = str(data.get("slug", "")).strip().lower()
    if not name or len(name) > 80 or not slug or len(slug) > 80:
        return error("Department name and slug are required (max 80 characters).")
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", slug):
        return error("Department slug may contain lowercase letters, digits, and single hyphens.")
    if Department.query.filter(or_(Department.name.ilike(name), Department.slug == slug)).first():
        return error("A department with that name or slug already exists.", 409)
    department = Department(name=name, slug=slug)
    db.session.add(department)
    db.session.flush()
    record_action(current_user(), "CREATE", "Department", department.id, f"Created department {name}.")
    db.session.commit()
    return jsonify({"id": department.id, "name": department.name, "slug": department.slug, "member_count": 0}), 201


@api.patch("/admin/departments/<int:department_id>")
@staff_required("MAIN_ADMIN")
def update_department(department_id):
    department = db.session.get(Department, department_id)
    if not department:
        return error("Department not found.", 404)
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", department.name)).strip()
    slug = str(data.get("slug", department.slug)).strip().lower()
    if not name or len(name) > 80 or not slug or len(slug) > 80:
        return error("Department name and slug are required (max 80 characters).")
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", slug):
        return error("Department slug may contain lowercase letters, digits, and single hyphens.")
    if department.slug in ROUTING_DEPARTMENT_SLUGS and slug != department.slug:
        return error("A routing department slug cannot be changed.", 409)
    if slug in ROUTING_DEPARTMENT_SLUGS and slug != department.slug:
        return error("That slug is reserved for ticket routing.", 409)
    conflict = Department.query.filter(
        Department.id != department.id,
        or_(Department.name.ilike(name), Department.slug == slug),
    ).first()
    if conflict:
        return error("A department with that name or slug already exists.", 409)
    department.name = name
    department.slug = slug
    record_action(current_user(), "UPDATE", "Department", department.id, f"Updated department {name}.")
    db.session.commit()
    return jsonify({"id": department.id, "name": department.name, "slug": department.slug})


@api.delete("/admin/departments/<int:department_id>")
@staff_required("MAIN_ADMIN")
def delete_department(department_id):
    department = db.session.get(Department, department_id)
    if not department:
        return error("Department not found.", 404)
    if department.slug in ROUTING_DEPARTMENT_SLUGS:
        return error("A required ticket-routing department cannot be deleted.", 409)
    if User.query.filter_by(department_id=department.id).first() or Ticket.query.filter_by(department_id=department.id).first():
        return error("A department with users or tickets cannot be deleted.", 409)
    record_action(current_user(), "DELETE", "Department", department.id, f"Deleted department {department.name}.")
    db.session.delete(department)
    db.session.commit()
    return "", 204


@api.get("/admin/roles")
@staff_required("MAIN_ADMIN")
def list_roles():
    return jsonify([{"id": role.id, "name": role.name} for role in Role.query.order_by(Role.name).all()])


@api.get("/admin/activities")
@staff_required("MAIN_ADMIN")
def list_activities():
    try:
        limit = min(200, max(1, int(request.args.get("limit", "50"))))
    except ValueError:
        return error("limit must be an integer.")
    logs = ActivityLog.query.order_by(ActivityLog.created_at.desc()).limit(limit).all()
    return jsonify([{
        "id": item.id,
        "actor": item.actor.to_dict() if item.actor else None,
        "action": item.action,
        "object_type": item.object_type,
        "object_id": item.object_id,
        "summary": item.summary,
        "created_at": item.created_at.isoformat(),
    } for item in logs])


@api.get("/admin/audit-logs")
@staff_required("MAIN_ADMIN")
def list_audit_logs():
    try:
        limit = min(200, max(1, int(request.args.get("limit", "50"))))
    except ValueError:
        return error("limit must be an integer.")
    logs = AuditLog.query.order_by(AuditLog.created_at.desc()).limit(limit).all()
    results = []
    for item in logs:
        details = item.details
        if item.object_type == "Ticket":
            ticket = (
                db.session.get(Ticket, int(item.object_id))
                if item.object_id.isdigit() else None
            )
            details = {"status": ticket.status if ticket else "UNAVAILABLE"}
        results.append({
            "id": item.id,
            "actor": item.actor.to_dict() if item.actor else None,
            "action": item.action,
            "object_type": item.object_type,
            "object_id": item.object_id,
            "details": details,
            "ip_address": item.ip_address,
            "created_at": item.created_at.isoformat(),
        })
    return jsonify(results)


@api.get("/admin/reports/tickets.csv")
@staff_required("MAIN_ADMIN")
def export_tickets_csv():
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Ticket", "Status"])
    tickets = Ticket.query.order_by(Ticket.created_at.desc()).all()
    for ticket in tickets:
        writer.writerow([ticket.ticket_number, ticket.status])
    record_action(current_user(), "EXPORT", "Ticket", "all", "Exported ticket report as CSV.")
    db.session.commit()
    return send_file(io.BytesIO(output.getvalue().encode("utf-8-sig")), mimetype="text/csv",
                     as_attachment=True, download_name="smart-crm-tickets.csv")


@api.get("/admin/reports/tickets.xlsx")
@staff_required("MAIN_ADMIN")
def export_tickets_xlsx():
    from openpyxl import Workbook
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Tickets"
    sheet.append(["Ticket", "Status"])
    for ticket in Ticket.query.order_by(Ticket.created_at.desc()).all():
        sheet.append([ticket.ticket_number, ticket.status])
    stream = io.BytesIO()
    workbook.save(stream)
    stream.seek(0)
    record_action(current_user(), "EXPORT", "Ticket", "all", "Exported ticket report as Excel.")
    db.session.commit()
    return send_file(stream, mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                     as_attachment=True, download_name="smart-crm-tickets.xlsx")


@api.get("/admin/reports/tickets.pdf")
@staff_required("MAIN_ADMIN")
def export_tickets_pdf():
    stream = io.BytesIO()
    document = canvas.Canvas(stream, pagesize=letter)
    width, height = letter
    y = height - 48
    document.setFont("Helvetica-Bold", 15)
    document.drawString(40, y, "NEXUS CRM Ticket Report")
    document.setFont("Helvetica", 8)
    y -= 28
    for ticket in Ticket.query.order_by(Ticket.created_at.desc()).limit(1000).all():
        line = f"{ticket.ticket_number} | {ticket.status}"
        document.drawString(40, y, line[:130])
        y -= 13
        if y < 45:
            document.showPage()
            y = height - 48
            document.setFont("Helvetica", 8)
    document.save()
    stream.seek(0)
    record_action(current_user(), "EXPORT", "Ticket", "all", "Exported ticket report as PDF.")
    db.session.commit()
    return send_file(stream, mimetype="application/pdf", as_attachment=True, download_name="smart-crm-tickets.pdf")
