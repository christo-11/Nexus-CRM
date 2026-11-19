import logging
from concurrent.futures import ThreadPoolExecutor
from html import escape
from datetime import datetime, timedelta, timezone
from email.utils import parseaddr
from uuid import uuid4

from flask import current_app, request
from flask_jwt_extended import get_jwt_identity
from flask_mail import Message
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError

from .extensions import db, mail
from .models import ActivityLog, AuditLog, Department, Notification, Role, Ticket, User

logger = logging.getLogger(__name__)
_lead_email_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="crm-lead-email")
TICKET_CATEGORIES = {"PRODUCT_ENQUIRY", "PRODUCT_DEFECT", "TECHNICAL_SUPPORT"}
PRIORITIES = {"LOW", "MEDIUM", "HIGH", "CRITICAL"}
TICKET_STATUSES = {"NEW", "ASSIGNED", "IN_PROGRESS", "MEETING_SCHEDULED", "RESOLVED", "CLOSED"}


def serializer(purpose):
    return URLSafeTimedSerializer(current_app.config["SECRET_KEY"], salt=f"smart-crm-{purpose}")


def make_token(email, purpose, version=None):
    value = email.lower() if version is None else {"email": email.lower(), "version": version}
    return serializer(purpose).dumps(value)


def read_token(token, purpose):
    try:
        return serializer(purpose).loads(token, max_age=current_app.config["RESET_TOKEN_MAX_AGE"])
    except (BadSignature, SignatureExpired):
        return None


def current_user():
    from .models import User
    identity = get_jwt_identity()
    if not identity or not str(identity).isdigit():
        return None
    return db.session.get(User, int(identity))


def can_manage_users(user):
    return user.role.name == "MAIN_ADMIN"


def is_staff(user):
    return user.role.name != "CUSTOMER"


def record_action(actor, action, object_type, object_id, summary, details=None):
    db.session.add(ActivityLog(
        actor_id=actor.id if actor else None,
        action=action,
        object_type=object_type,
        object_id=str(object_id),
        summary=summary[:500],
    ))
    db.session.add(AuditLog(
        actor_id=actor.id if actor else None,
        action=action,
        object_type=object_type,
        object_id=str(object_id),
        details=details or {},
        ip_address=request.remote_addr,
    ))


def route_ticket(category, priority):
    slug = "main-admin" if priority == "CRITICAL" else {
        "PRODUCT_ENQUIRY": "sales",
        "PRODUCT_DEFECT": "product-maintenance",
        "TECHNICAL_SUPPORT": "support",
    }[category]
    department = Department.query.filter_by(slug=slug).first()
    if department is None:
        raise RuntimeError(f"Required routing department is missing: {slug}")
    candidates = User.query.filter_by(department_id=department.id, is_active=True).all()
    if slug == "main-admin":
        candidates = User.query.join(Role).filter(Role.name == "MAIN_ADMIN", User.is_active.is_(True)).all()
    assignee = None
    if candidates:
        workload = dict(
            db.session.query(Ticket.assignee_id, func.count(Ticket.id))
            .filter(Ticket.assignee_id.in_([item.id for item in candidates]))
            .filter(Ticket.status.notin_(["RESOLVED", "CLOSED"]))
            .group_by(Ticket.assignee_id)
            .all()
        )
        assignee = min(candidates, key=lambda item: (workload.get(item.id, 0), item.id))
    return department, assignee


def notify_user(user, kind, title, body, ticket=None, link="", idempotency_key=None):
    if not user:
        return
    if idempotency_key:
        existing = Notification.query.filter_by(
            recipient_id=user.id,
            idempotency_key=idempotency_key,
        ).first()
        if existing:
            return
    notification = Notification(
        recipient_id=user.id,
        ticket_id=ticket.id if ticket else None,
        idempotency_key=idempotency_key,
        kind=kind,
        title=title,
        body=body,
        link=link,
    )
    try:
        if idempotency_key:
            with db.session.begin_nested():
                db.session.add(notification)
                db.session.flush()
        else:
            db.session.add(notification)
            db.session.flush()
    except IntegrityError:
        if not idempotency_key:
            raise
        return Notification.query.filter_by(
            recipient_id=user.id,
            idempotency_key=idempotency_key,
        ).first()
    from .realtime import emit_to_user
    emit_to_user(user.id, "notification", notification.to_dict())
    return notification


def notify_ticket_parties(ticket, kind, title, body, include_customer=True):
    recipients = {ticket.assignee_id: ticket.assignee}
    if include_customer:
        recipients[ticket.customer_id] = ticket.customer
    for user in recipients.values():
        if user:
            notify_user(user, kind, title, body, ticket)


def send_user_email(recipient, subject, body, html=None):
    if not recipient or not parseaddr(recipient)[1]:
        logger.error("Email delivery skipped because recipient address is invalid.")
        return False
    username = current_app.config.get("MAIL_USERNAME") or ""
    password = current_app.config.get("MAIL_PASSWORD") or ""
    sender = current_app.config.get("MAIL_DEFAULT_SENDER") or username
    if not username or not password:
        logger.warning(
            "SMTP is not configured; email to %s was not delivered. Set MAIL_USERNAME and MAIL_PASSWORD in flask-backend/.env.",
            recipient,
        )
        return False
    try:
        mail.send(Message(
            subject=subject,
            sender=sender,
            recipients=[recipient],
            body=body,
            html=html,
        ))
        return True
    except Exception:
        logger.exception("CRM email delivery failed for %s", recipient)
        return False


def queue_lead_email(app, communication_id):
    _lead_email_executor.submit(_deliver_lead_email, app, communication_id)


def queue_crm_email(app, recipient, subject, body, html=None):
    smtp_configured = bool(app.config.get("MAIL_USERNAME") and app.config.get("MAIL_PASSWORD"))
    if (
        app.config.get("TESTING")
        or not recipient
        or not smtp_configured
    ):
        if recipient and not smtp_configured and not app.config.get("TESTING"):
            logger.warning(
                "CRM email to %s was not queued because no SMTP credentials are configured.",
                recipient,
            )
        return False
    try:
        _lead_email_executor.submit(
            _deliver_crm_email,
            app,
            recipient,
            subject,
            body,
            html,
        )
        return True
    except RuntimeError:
        logger.exception("Could not queue CRM notification email for %s.", recipient)
        return False


def _deliver_crm_email(app, recipient, subject, body, html=None):
    with app.app_context():
        try:
            send_user_email(recipient, subject, body, html=html)
        except Exception:
            logger.exception("Could not process queued CRM notification email for %s.", recipient)
        finally:
            db.session.remove()


def _deliver_lead_email(app, communication_id):
    from .models import LeadCommunication

    with app.app_context():
        try:
            communication = db.session.get(LeadCommunication, communication_id)
            if communication is None or communication.delivery_status != "QUEUED":
                return
            delivered = send_user_email(
                communication.recipient,
                communication.subject,
                communication.body,
            )
            communication.delivery_status = "SMTP_ACCEPTED" if delivered else "FAILED"
            if not delivered:
                communication.delivery_error = "SMTP did not accept the message."
            db.session.commit()
        except Exception:
            db.session.rollback()
            logger.exception("Could not process queued lead email %s.", communication_id)
        finally:
            db.session.remove()


def send_email(recipient, subject, text_body, html_body=None):
    return send_user_email(recipient, subject, text_body, html_body)


def sales_enquiry_email_content(
    recipient_name,
    title,
    introduction,
    details,
    message,
    cta_label=None,
    cta_url=None,
):
    detail_lines = [f"{label}: {value}" for label, value in details]
    text_body = (
        f"Hello {recipient_name},\n\n"
        f"{introduction}\n\n"
        + "\n".join(detail_lines)
        + f"\n\nEnquiry message:\n{message}\n\n"
    )
    if cta_label and cta_url:
        text_body += f"{cta_label}: {cta_url}\n\n"
    text_body += "Kind regards,\nNEXUS CRM\n\nThis is an automated message from NEXUS CRM."

    html_details = "".join(
        '<tr><th align="left" style="padding:10px 12px;border-bottom:1px solid #e2e8f0;'
        'font-size:13px;color:#64748b;font-weight:600;">'
        f'{escape(str(label))}</th><td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;'
        f'font-size:14px;color:#0f172a;">{escape(str(value))}</td></tr>'
        for label, value in details
    )
    cta = ""
    if cta_label and cta_url:
        safe_url = escape(cta_url, quote=True)
        cta = (
            '<p style="margin:24px 0 0;"><a href="'
            f'{safe_url}" style="display:inline-block;padding:12px 20px;'
            'background:#2563eb;border-radius:8px;color:#ffffff;text-decoration:none;'
            f'font-weight:600;">{escape(cta_label)}</a></p>'
        )
    html_body = (
        '<div style="margin:0;background:#f1f5f9;padding:32px 16px;'
        'font-family:Arial,Helvetica,sans-serif;color:#0f172a;">'
        '<div style="max-width:620px;margin:0 auto;background:#ffffff;'
        'border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">'
        '<div style="padding:22px 28px;background:#172744;color:#ffffff;">'
        '<p style="margin:0;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;'
        'color:#bae6fd;">NEXUS CRM</p>'
        f'<h1 style="margin:8px 0 0;font-size:22px;">{escape(title)}</h1></div>'
        '<div style="padding:26px 28px;">'
        f'<p style="margin:0 0 16px;">Hello {escape(recipient_name)},</p>'
        f'<p style="margin:0 0 22px;line-height:1.6;color:#334155;">'
        f'{escape(introduction)}</p>'
        '<table role="presentation" style="width:100%;border:1px solid #e2e8f0;'
        'border-collapse:collapse;border-radius:10px;overflow:hidden;">'
        f'{html_details}</table>'
        '<div style="margin:22px 0 0;padding:16px;background:#f8fafc;'
        'border-left:3px solid #38bdf8;border-radius:4px;">'
        '<p style="margin:0 0 8px;font-size:12px;font-weight:700;'
        'letter-spacing:.5px;text-transform:uppercase;color:#64748b;">Enquiry message</p>'
        f'<p style="margin:0;line-height:1.6;color:#334155;white-space:pre-wrap;'
        f'overflow-wrap:anywhere;">{escape(message)}</p></div>'
        f'{cta}'
        '<p style="margin:28px 0 0;font-size:13px;color:#475569;">Kind regards,<br>'
        'NEXUS CRM</p><p style="margin:18px 0 0;font-size:11px;color:#94a3b8;">'
        'This is an automated message from NEXUS CRM.</p>'
        '</div></div></div>'
    )
    return text_body, html_body


def sales_assignment_email_content(details, message, cta_url):
    greeting = "Hello Sales Team,"
    introduction = (
        "A new sales enquiry has been received and assigned to your team. "
        "Please review the customer details and follow up promptly."
    )
    footer = (
        "This is an automated notification from Nexus CRM. "
        "Please review and follow up with the customer promptly."
    )
    detail_lines = [f"{label}: {value}" for label, value in details]
    text_body = (
        f"{greeting}\n\n{introduction}\n\n"
        + "\n".join(detail_lines)
        + f"\n\nCustomer enquiry:\n{message}\n\n"
        f"View Lead Details: {cta_url}\n\n{footer}"
    )

    html_details = "".join(
        '<tr><td style="padding:12px 14px;border-bottom:1px solid #e8ebf0;'
        'font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:600;'
        f'color:#64748b;">{escape(str(label))}</td>'
        '<td style="padding:12px 14px;border-bottom:1px solid #e8ebf0;'
        'font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;'
        f'color:#17243a;overflow-wrap:anywhere;">{escape(str(value))}</td></tr>'
        for label, value in details
    )
    safe_cta_url = escape(cta_url, quote=True)
    safe_message = escape(message).replace("\r\n", "\n").replace("\r", "\n").replace("\n", "<br>")
    html_body = (
        '<!doctype html><html><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<meta name="color-scheme" content="light">'
        '<title>New Sales Enquiry – Nexus CRM</title></head>'
        '<body style="margin:0;padding:0;background-color:#f3f5f8;">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
        'style="width:100%;border-collapse:collapse;background-color:#f3f5f8;">'
        '<tr><td align="center" style="padding:28px 12px;">'
        '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" '
        'style="width:100%;max-width:600px;border-collapse:separate;background-color:#ffffff;'
        'border:1px solid #e3e7ed;border-radius:8px;overflow:hidden;">'
        '<tr><td bgcolor="#14243a" style="padding:24px 28px;background-color:#14243a;'
        'border-bottom:4px solid #d5a34b;">'
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0">'
        '<tr><td width="38" height="38" align="center" valign="middle" bgcolor="#d5a34b" '
        'style="width:38px;height:38px;background-color:#d5a34b;border-radius:6px;'
        'font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:700;color:#14243a;">'
        'N</td><td style="padding-left:12px;font-family:Arial,Helvetica,sans-serif;'
        'font-size:19px;font-weight:700;letter-spacing:1.2px;color:#ffffff;">'
        'NEXUS <span style="font-weight:400;color:#e3bd78;">CRM</span></td></tr></table>'
        '</td></tr>'
        '<tr><td style="padding:30px 28px 8px;'
        'font-family:Arial,Helvetica,sans-serif;color:#17243a;">'
        '<p style="margin:0 0 16px;font-size:15px;line-height:23px;font-weight:600;">'
        'Hello Sales Team,</p>'
        '<h1 style="margin:0 0 12px;font-size:23px;line-height:30px;color:#14243a;">'
        'New sales enquiry assigned</h1>'
        '<p style="margin:0;font-size:14px;line-height:22px;color:#526174;">'
        'A new sales enquiry has been received and assigned to your team. '
        'Please review the customer details and follow up promptly.</p>'
        '</td></tr>'
        '<tr><td style="padding:20px 28px 0;">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
        'style="width:100%;border:1px solid #e3e7ed;border-collapse:collapse;">'
        f'{html_details}</table></td></tr>'
        '<tr><td style="padding:22px 28px 0;">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
        'style="width:100%;border-collapse:collapse;background-color:#fffaf0;'
        'border-left:4px solid #d5a34b;">'
        '<tr><td style="padding:16px 18px;font-family:Arial,Helvetica,sans-serif;">'
        '<p style="margin:0 0 8px;font-size:11px;line-height:16px;font-weight:700;'
        'letter-spacing:1px;text-transform:uppercase;color:#8a6424;">Customer enquiry</p>'
        '<p style="margin:0;font-size:14px;line-height:22px;color:#364152;'
        f'overflow-wrap:anywhere;">{safe_message}</p></td></tr></table>'
        '</td></tr>'
        '<tr><td align="center" style="padding:26px 28px 8px;">'
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0">'
        '<tr><td align="center" bgcolor="#d5a34b" style="background-color:#d5a34b;'
        'border-radius:5px;">'
        f'<a href="{safe_cta_url}" target="_blank" style="display:inline-block;padding:13px 24px;'
        'font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;'
        'font-weight:700;color:#14243a;text-decoration:none;">View Lead Details</a>'
        '</td></tr></table></td></tr>'
        '<tr><td style="padding:24px 28px 28px;font-family:Arial,Helvetica,sans-serif;'
        'font-size:12px;line-height:19px;color:#687588;">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
        'style="width:100%;border-collapse:collapse;border-top:1px solid #e8ebf0;">'
        '<tr><td style="padding-top:18px;">'
        f'{escape(footer)}</td></tr></table></td></tr>'
        '</table></td></tr></table></body></html>'
    )
    return text_body, html_body


def _ticket_email_content(ticket, event, recipient_name, meeting_url=None):
    priority = ticket.priority.title()
    status = ticket.status.replace("_", " ").title()
    customer = (
        f"{ticket.customer.name} ({ticket.customer.email})"
        if ticket.customer else "Deleted account"
    )
    fields = [
        ("Ticket ID", ticket.ticket_number),
        ("Customer", customer),
        ("Subject", ticket.subject),
        ("Priority", priority),
        ("Status", status),
        ("Update", event),
    ]
    critical_text = (
        "CRITICAL PRIORITY — IMMEDIATE ATTENTION REQUIRED\n\n"
        if ticket.priority == "CRITICAL" else ""
    )
    text_body = (
        f"Hello {recipient_name},\n\n"
        f"{critical_text}"
        f"Ticket update\n\n"
        + "\n".join(f"- {label}: {value}" for label, value in fields)
    )
    if meeting_url:
        text_body += f"\n- Meeting link: {meeting_url}"
    text_body += "\n\nThis is an automated message from NEXUS CRM."

    critical_banner = ""
    if ticket.priority == "CRITICAL":
        critical_banner = (
            '<p style="margin:0 0 20px;padding:12px 16px;border-radius:8px;'
            'background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;'
            'font-weight:700;">CRITICAL PRIORITY — IMMEDIATE ATTENTION REQUIRED</p>'
        )
    html_fields = "".join(
        '<li style="margin:0 0 10px;color:#334155;">'
        f'<strong style="color:#0f172a;">{escape(label)}:</strong> {escape(str(value))}</li>'
        for label, value in fields
    )
    meeting_row = ""
    if meeting_url:
        safe_meeting_url = escape(meeting_url, quote=True)
        meeting_row = (
            '<li style="margin:0 0 10px;color:#334155;"><strong style="color:#0f172a;">'
            f'Meeting link:</strong> <a href="{safe_meeting_url}" style="color:#2563eb;">'
            f'{escape(meeting_url)}</a></li>'
        )
    html_body = (
        '<div style="margin:0;background:#f1f5f9;padding:32px 16px;'
        'font-family:Arial,Helvetica,sans-serif;color:#0f172a;">'
        '<div style="max-width:600px;margin:0 auto;background:#ffffff;'
        'border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">'
        '<div style="padding:22px 28px;background:#172744;color:#ffffff;">'
        '<p style="margin:0;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;'
        'color:#bae6fd;">NEXUS CRM</p>'
        '<h1 style="margin:8px 0 0;font-size:22px;">Ticket update</h1></div>'
        '<div style="padding:26px 28px;">'
        f'<p style="margin:0 0 20px;">Hello {escape(recipient_name)},</p>'
        f'{critical_banner}'
        '<h2 style="margin:0 0 12px;font-size:15px;color:#475569;">Ticket details</h2>'
        '<ul style="margin:0;padding:16px 16px 8px 32px;background:#f8fafc;'
        'border:1px solid #e2e8f0;border-radius:10px;">'
        f'{html_fields}{meeting_row}</ul>'
        '<p style="margin:24px 0 0;font-size:12px;color:#64748b;">'
        'This is an automated message from NEXUS CRM.</p>'
        '</div></div></div>'
    )
    return text_body, html_body


def send_ticket_email(ticket, event, meeting_url=None):
    if not ticket.customer:
        return False
    text_body, html_body = _ticket_email_content(
        ticket, event, ticket.customer.name, meeting_url,
    )
    priority_prefix = "[CRITICAL] " if ticket.priority == "CRITICAL" else ""
    return send_user_email(
        ticket.customer.email,
        f"{priority_prefix}[{ticket.ticket_number}] {event}",
        text_body,
        html_body,
    )


def send_assignee_email(ticket, event):
    if not ticket.assignee:
        return False
    text_body, html_body = _ticket_email_content(
        ticket, event, ticket.assignee.name,
    )
    priority_prefix = "[CRITICAL] " if ticket.priority == "CRITICAL" else ""
    return send_user_email(
        ticket.assignee.email,
        f"{priority_prefix}[{ticket.ticket_number}] {event}",
        text_body,
        html_body,
    )


def send_product_defect_email(ticket):
    if ticket.issue_category != "PRODUCT_DEFECT" or ticket.department.slug != "product-maintenance":
        return False

    recipients = User.query.filter_by(
        department_id=ticket.department_id,
        is_active=True,
    ).order_by(User.id).all()
    if not recipients:
        logger.warning(
            "Cannot notify Product Maintenance about ticket %s: no active department members exist.",
            ticket.ticket_number,
        )
        return False

    customer = (
        f"{ticket.customer.name} ({ticket.customer.email})"
        if ticket.customer else "Deleted account"
    )
    product = ticket.product.name if ticket.product else "Not specified"
    body = (
        "A customer reported a product defect.\n\n"
        f"Ticket ID: {ticket.ticket_number}\n"
        f"Customer: {customer}\n"
        f"Product: {product}\n"
        f"Subject: {ticket.subject}\n"
        f"Priority: {ticket.priority.title()}\n"
        f"Description: {ticket.description}\n\n"
        "Please review and follow up in NEXUS CRM."
    )
    results = [
        send_user_email(
            recipient.email,
            f"[{ticket.ticket_number}] Product defect requires attention",
            f"Hello {recipient.name},\n\n{body}",
        )
        for recipient in recipients
    ]
    return all(results)


def create_ticket_number():
    return "TKT" + uuid4().hex[:12].upper()


def ticket_visible_to(user, ticket):
    if user.role.name == "MAIN_ADMIN":
        return True
    if user.role.name == "CUSTOMER":
        return ticket.customer_id == user.id
    return ticket.department_id == user.department_id or ticket.assignee_id == user.id


def parse_datetime(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("starts_at must be an ISO 8601 datetime.")
    parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("starts_at must include a timezone.")
    parsed = parsed.astimezone(timezone.utc)
    if parsed <= datetime.now(timezone.utc) + timedelta(seconds=30):
        raise ValueError("Meeting must be scheduled at least 30 seconds in the future.")
    return parsed


def get_role(name):
    role = Role.query.filter_by(name=name).first()
    if not role:
        raise RuntimeError(f"Required role is missing: {name}")
    return role


def token_claims(user):
    return {
        "role": user.role.name,
        "department_id": user.department_id,
        "token_version": user.token_version,
    }
