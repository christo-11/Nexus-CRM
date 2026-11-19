from datetime import datetime, timezone
from uuid import uuid4
4

from werkzeug.security import check_password_hash, generate_password_hash

from .extensions import db


def utcnow():
    return datetime.now(timezone.utc)


class Role(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(40), unique=True, nullable=False)
    users = db.relationship("User", back_populates="role")


class Department(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), unique=True, nullable=False)
    slug = db.Column(db.String(80), unique=True, nullable=False)
    users = db.relationship("User", back_populates="department")


class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    public_id = db.Column(db.String(36), unique=True, default=lambda: str(uuid4()), nullable=False)
    name = db.Column(db.String(160), nullable=False)
    email = db.Column(db.String(254), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    role_id = db.Column(db.Integer, db.ForeignKey("role.id"), nullable=False)
    department_id = db.Column(db.Integer, db.ForeignKey("department.id"))
    is_active = db.Column(db.Boolean, nullable=False, default=True)
    email_verified_at = db.Column(db.DateTime(timezone=True))
    token_version = db.Column(db.Integer, nullable=False, default=0)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)
    role = db.relationship("Role", back_populates="users")
    department = db.relationship("Department", back_populates="users")
    customer_tickets = db.relationship("Ticket", back_populates="customer", foreign_keys="Ticket.customer_id")
    assigned_tickets = db.relationship("Ticket", back_populates="assignee", foreign_keys="Ticket.assignee_id")
    notifications = db.relationship("Notification", back_populates="recipient", cascade="all, delete-orphan")

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "email": self.email,
            "role": self.role.name,
            "department": self.department.name if self.department else None,
            "email_verified": self.email_verified_at is not None,
            "is_active": self.is_active,
        }


class FeedbackReview(db.Model):
    __tablename__ = "feedback_review"
    __table_args__ = (
        db.CheckConstraint("rating >= 1 AND rating <= 5", name="ck_feedback_review_rating"),
        db.CheckConstraint(
            "status IN ('pending', 'approved', 'rejected')",
            name="ck_feedback_review_status",
        ),
        db.Index("ix_feedback_review_status_created_at", "status", "created_at"),
    )

    id = db.Column(db.Integer, primary_key=True)
    customer_id = db.Column(db.Integer, db.ForeignKey("user.id", ondelete="SET NULL"), index=True)
    title = db.Column(db.String(120))
    comment = db.Column(db.Text, nullable=False)
    rating = db.Column(db.Integer, nullable=False)
    status = db.Column(db.String(16), nullable=False, default="pending", server_default="pending")
    display_name = db.Column(db.String(80))
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, server_default=db.func.now())
    updated_at = db.Column(
        db.DateTime(timezone=True),
        nullable=False,
        server_default=db.func.now(),
        onupdate=utcnow,
    )
    moderated_at = db.Column(db.DateTime(timezone=True))
    moderator_id = db.Column(db.Integer, db.ForeignKey("user.id", ondelete="SET NULL"))

    customer = db.relationship("User", foreign_keys=[customer_id])
    moderator = db.relationship("User", foreign_keys=[moderator_id])


class RevokedToken(db.Model):
    jti = db.Column(db.String(36), primary_key=True)
    revoked_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)


class Product(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(180), nullable=False)
    category = db.Column(db.String(100), nullable=False)
    description = db.Column(db.Text, nullable=False, default="")
    price = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    status = db.Column(db.String(20), nullable=False, default="ACTIVE")
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)
    tickets = db.relationship("Ticket", back_populates="product")

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "category": self.category,
            "description": self.description,
            "price": str(self.price),
            "status": self.status,
            "created_at": self.created_at.isoformat(),
        }


class Lead(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    contact_name = db.Column(db.String(160), nullable=False)
    email = db.Column(db.String(254), nullable=False, index=True)
    company = db.Column(db.String(180), nullable=False, default="")
    phone = db.Column(db.String(40), nullable=False, default="")
    product_id = db.Column(db.Integer, db.ForeignKey("product.id"))
    notes = db.Column(db.Text, nullable=False, default="")
    status = db.Column(db.String(20), nullable=False, default="NEW", index=True)
    dedupe_key = db.Column(db.String(64), unique=True, index=True)
    source = db.Column(db.String(40), nullable=False, default="Website Enquiry")
    customer_requirements = db.Column(db.Text, nullable=False, default="")
    support_verification_notes = db.Column(db.Text, nullable=False, default="")
    customer_interest_status = db.Column(db.String(24), nullable=False, default="AWAITING_RESPONSE")
    purchase_intent = db.Column(db.String(24), nullable=False, default="UNKNOWN")
    approval_status = db.Column(db.String(24), nullable=False, default="NOT_SUBMITTED", index=True)
    follow_up_at = db.Column(db.DateTime(timezone=True))
    assigned_to_id = db.Column(db.Integer, db.ForeignKey("user.id"), index=True)
    customer_id = db.Column(db.Integer, db.ForeignKey("user.id", ondelete="SET NULL"), index=True)
    support_assigned_to_id = db.Column(db.Integer, db.ForeignKey("user.id"), index=True)
    created_by_id = db.Column(db.Integer, db.ForeignKey("user.id"))
    support_verified_by_id = db.Column(db.Integer, db.ForeignKey("user.id"))
    support_verified_at = db.Column(db.DateTime(timezone=True))
    submitted_for_approval_at = db.Column(db.DateTime(timezone=True))
    approved_by_id = db.Column(db.Integer, db.ForeignKey("user.id"))
    approved_at = db.Column(db.DateTime(timezone=True))
    purchase_verified_by_id = db.Column(db.Integer, db.ForeignKey("user.id"))
    purchase_verified_at = db.Column(db.DateTime(timezone=True))
    purchase_verification_notes = db.Column(db.Text, nullable=False, default="")
    rejection_reason = db.Column(db.Text, nullable=False, default="")
    review_comment = db.Column(db.Text, nullable=False, default="")
    resubmission_count = db.Column(db.Integer, nullable=False, default=0)
    converted_customer_id = db.Column(db.Integer, db.ForeignKey("user.id"))
    converted_ticket_id = db.Column(db.Integer, db.ForeignKey("ticket.id"), unique=True)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow, index=True)
    updated_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)
    product = db.relationship("Product")
    customer = db.relationship("User", foreign_keys=[customer_id])
    assigned_to = db.relationship("User", foreign_keys=[assigned_to_id])
    support_assigned_to = db.relationship("User", foreign_keys=[support_assigned_to_id])
    created_by = db.relationship("User", foreign_keys=[created_by_id])
    support_verified_by = db.relationship("User", foreign_keys=[support_verified_by_id])
    approved_by = db.relationship("User", foreign_keys=[approved_by_id])
    purchase_verified_by = db.relationship("User", foreign_keys=[purchase_verified_by_id])
    converted_customer = db.relationship("User", foreign_keys=[converted_customer_id])
    converted_ticket = db.relationship("Ticket", foreign_keys=[converted_ticket_id])
    interest_events = db.relationship("ProductInterestEvent", back_populates="lead")
    enquiries = db.relationship("Enquiry", back_populates="lead", order_by="Enquiry.created_at")
    communications = db.relationship("LeadCommunication", back_populates="lead", order_by="LeadCommunication.created_at")
    approval_history = db.relationship("LeadApprovalHistory", back_populates="lead", order_by="LeadApprovalHistory.created_at")

    def to_dict(self, include_review=False):
        reviewer = include_review
        value = {
            "id": self.id,
            "contact_name": self.contact_name,
            "email": self.email,
            "company": self.company,
            "phone": self.phone,
            "product": {"id": self.product.id, "name": self.product.name} if self.product else None,
            "notes": self.notes,
            "status": self.status,
            "customer_id": self.customer_id,
            "source": self.source,
            "customer_requirements": self.customer_requirements if reviewer else None,
            "support_verification_notes": self.support_verification_notes if reviewer else None,
            "customer_interest_status": self.customer_interest_status,
            "purchase_intent": self.purchase_intent,
            "approval_status": self.approval_status,
            "follow_up_at": self.follow_up_at.isoformat() if self.follow_up_at else None,
            "support_assignee": self.support_assigned_to.to_dict() if self.support_assigned_to else None,
            "support_verified_by": self.support_verified_by.to_dict() if self.support_verified_by else None,
            "support_verified_at": self.support_verified_at.isoformat() if self.support_verified_at else None,
            "submitted_for_approval_at": self.submitted_for_approval_at.isoformat() if self.submitted_for_approval_at else None,
            "approved_by": self.approved_by.to_dict() if self.approved_by else None,
            "approved_at": self.approved_at.isoformat() if self.approved_at else None,
            "purchase_verified_by": self.purchase_verified_by.to_dict() if self.purchase_verified_by else None,
            "purchase_verified_at": self.purchase_verified_at.isoformat() if self.purchase_verified_at else None,
            "purchase_verification_notes": self.purchase_verification_notes if reviewer else "",
            "rejection_reason": self.rejection_reason,
            "review_comment": self.review_comment,
            "resubmission_count": self.resubmission_count,
            "interest_events": [event.to_dict() for event in self.interest_events] if reviewer else [],
            "communications": [communication.to_dict() for communication in self.communications] if reviewer else [],
            "enquiries": [enquiry.to_dict() for enquiry in self.enquiries] if reviewer else [],
            "approval_history": [entry.to_dict() for entry in self.approval_history] if reviewer else [],
            "assignee": self.assigned_to.to_dict() if self.assigned_to else None,
            "converted_customer_id": self.converted_customer_id,
            "converted_ticket_id": self.converted_ticket_id,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }
        return value


class Enquiry(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    lead_id = db.Column(db.Integer, db.ForeignKey("lead.id", ondelete="CASCADE"), nullable=False, index=True)
    customer_id = db.Column(db.Integer, db.ForeignKey("user.id", ondelete="SET NULL"), index=True)
    product_id = db.Column(db.Integer, db.ForeignKey("product.id", ondelete="SET NULL"), index=True)
    message = db.Column(db.Text, nullable=False)
    type = db.Column(db.String(24), nullable=False, default="SALES_ENQUIRY", index=True)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow, index=True)
    lead = db.relationship("Lead", back_populates="enquiries")
    customer = db.relationship("User")
    product = db.relationship("Product")

    def to_dict(self):
        return {
            "id": self.id,
            "lead_id": self.lead_id,
            "customer_id": self.customer_id,
            "product": {"id": self.product.id, "name": self.product.name} if self.product else None,
            "message": self.message,
            "type": self.type,
            "created_at": self.created_at.isoformat(),
        }


class ProductInterestEvent(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    product_id = db.Column(db.Integer, db.ForeignKey("product.id"), nullable=False, index=True)
    customer_id = db.Column(db.Integer, db.ForeignKey("user.id"), index=True)
    session_hash = db.Column(db.String(64), nullable=False)
    lead_id = db.Column(db.Integer, db.ForeignKey("lead.id"), index=True)
    first_seen_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)
    last_seen_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)
    visit_count = db.Column(db.Integer, nullable=False, default=1)
    product = db.relationship("Product")
    customer = db.relationship("User")
    lead = db.relationship("Lead", back_populates="interest_events")

    __table_args__ = (db.UniqueConstraint("product_id", "session_hash", name="uq_product_interest_session"),)

    def to_dict(self):
        return {
            "id": self.id,
            "product_id": self.product_id,
            "product_name": self.product.name if self.product else None,
            "customer_id": self.customer_id,
            "lead_id": self.lead_id,
            "first_seen_at": self.first_seen_at.isoformat(),
            "last_seen_at": self.last_seen_at.isoformat(),
            "visit_count": self.visit_count,
        }


class LeadApprovalHistory(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    lead_id = db.Column(db.Integer, db.ForeignKey("lead.id"), nullable=False, index=True)
    actor_id = db.Column(db.Integer, db.ForeignKey("user.id"))
    action = db.Column(db.String(40), nullable=False)
    comment = db.Column(db.Text, nullable=False, default="")
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)
    actor = db.relationship("User")
    lead = db.relationship("Lead", back_populates="approval_history")

    def to_dict(self):
        return {
            "id": self.id,
            "actor": self.actor.to_dict() if self.actor else None,
            "action": self.action,
            "comment": self.comment,
            "created_at": self.created_at.isoformat(),
        }


class LeadCommunication(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    lead_id = db.Column(db.Integer, db.ForeignKey("lead.id"), nullable=False, index=True)
    sender_id = db.Column(db.Integer, db.ForeignKey("user.id"))
    recipient = db.Column(db.String(254), nullable=False)
    subject = db.Column(db.String(240), nullable=False)
    body = db.Column(db.Text, nullable=False)
    delivery_status = db.Column(db.String(20), nullable=False, default="QUEUED")
    delivery_error = db.Column(db.String(500), nullable=False, default="")
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)
    lead = db.relationship("Lead", back_populates="communications")
    sender = db.relationship("User")

    def to_dict(self):
        return {
            "id": self.id,
            "sender": self.sender.to_dict() if self.sender else None,
            "recipient": self.recipient,
            "subject": self.subject,
            "body": self.body,
            "delivery_status": self.delivery_status,
            "delivery_error": self.delivery_error,
            "created_at": self.created_at.isoformat(),
        }


class Ticket(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    ticket_number = db.Column(db.String(24), unique=True, nullable=False, index=True)
    customer_id = db.Column(db.Integer, db.ForeignKey("user.id"), index=True)
    product_id = db.Column(db.Integer, db.ForeignKey("product.id"))
    issue_category = db.Column(db.String(40), nullable=False)
    subject = db.Column(db.String(240), nullable=False)
    description = db.Column(db.Text, nullable=False)
    priority = db.Column(db.String(12), nullable=False, default="MEDIUM", index=True)
    status = db.Column(db.String(24), nullable=False, default="NEW", index=True)
    department_id = db.Column(db.Integer, db.ForeignKey("department.id"), nullable=False, index=True)
    assignee_id = db.Column(db.Integer, db.ForeignKey("user.id"), index=True)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow, index=True)
    updated_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)
    customer = db.relationship("User", back_populates="customer_tickets", foreign_keys=[customer_id])
    assignee = db.relationship("User", back_populates="assigned_tickets", foreign_keys=[assignee_id])
    department = db.relationship("Department")
    product = db.relationship("Product", back_populates="tickets")
    comments = db.relationship("TicketComment", back_populates="ticket", cascade="all, delete-orphan", order_by="TicketComment.created_at")
    documents = db.relationship("TicketDocument", back_populates="ticket", cascade="all, delete-orphan")
    meetings = db.relationship("Meeting", back_populates="ticket", cascade="all, delete-orphan")

    def to_dict(self, include_comments=False, include_internal_comments=True):
        value = {
            "id": self.id,
            "ticket_number": self.ticket_number,
            "customer": self.customer.to_dict() if self.customer else None,
            "product": {"id": self.product.id, "name": self.product.name} if self.product else None,
            "issue_category": self.issue_category,
            "subject": self.subject,
            "description": self.description,
            "priority": self.priority,
            "status": self.status,
            "department": self.department.name,
            "assignee": self.assignee.to_dict() if self.assignee else None,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
            "documents": [item.to_dict() for item in self.documents],
            "meetings": [item.to_dict() for item in self.meetings],
        }
        if include_comments:
            value["comments"] = [
                comment.to_dict() for comment in self.comments
                if include_internal_comments or not comment.is_internal
            ]
        return value


class TicketComment(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    ticket_id = db.Column(db.Integer, db.ForeignKey("ticket.id"), nullable=False, index=True)
    author_id = db.Column(db.Integer, db.ForeignKey("user.id"))
    body = db.Column(db.Text, nullable=False)
    is_internal = db.Column(db.Boolean, nullable=False, default=False)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)
    ticket = db.relationship("Ticket", back_populates="comments")
    author = db.relationship("User")

    def to_dict(self):
        return {
            "id": self.id,
            "author": self.author.to_dict() if self.author else None,
            "body": self.body,
            "is_internal": self.is_internal,
            "created_at": self.created_at.isoformat(),
        }


class TicketDocument(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    ticket_id = db.Column(db.Integer, db.ForeignKey("ticket.id"), nullable=False, index=True)
    uploaded_by_id = db.Column(db.Integer, db.ForeignKey("user.id"))
    original_name = db.Column(db.String(255), nullable=False)
    stored_name = db.Column(db.String(255), unique=True, nullable=False)
    content_type = db.Column(db.String(120), nullable=False, default="application/octet-stream")
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)
    ticket = db.relationship("Ticket", back_populates="documents")
    uploaded_by = db.relationship("User")

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.original_name,
            "content_type": self.content_type,
            "created_at": self.created_at.isoformat(),
        }


class Meeting(db.Model):
    __table_args__ = (
        db.UniqueConstraint("request_key", name="uq_meeting_request_key"),
        db.CheckConstraint(
            "ticket_id IS NOT NULL OR lead_id IS NOT NULL",
            name="ck_meeting_ticket_or_lead",
        ),
    )

    id = db.Column(db.Integer, primary_key=True)
    ticket_id = db.Column(db.Integer, db.ForeignKey("ticket.id"), index=True)
    lead_id = db.Column(db.Integer, db.ForeignKey("lead.id"), index=True)
    request_key = db.Column(db.String(64), nullable=True)
    starts_at = db.Column(db.DateTime(timezone=True), nullable=False, index=True)
    duration_minutes = db.Column(db.Integer, nullable=False, default=30)
    jitsi_url = db.Column(db.String(500), nullable=False)
    created_by_id = db.Column(db.Integer, db.ForeignKey("user.id"))
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)
    ticket = db.relationship("Ticket", back_populates="meetings")
    lead = db.relationship("Lead")
    created_by = db.relationship("User")

    def to_dict(self):
        return {
            "id": self.id,
            "ticket_id": self.ticket_id,
            "ticket_number": self.ticket.ticket_number if self.ticket else None,
            "lead_id": self.lead_id,
            "lead_contact_name": self.lead.contact_name if self.lead else None,
            "starts_at": self.starts_at.isoformat(),
            "duration_minutes": self.duration_minutes,
            "jitsi_url": self.jitsi_url,
            "created_by": self.created_by.to_dict() if self.created_by else None,
        }


class Notification(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    recipient_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False, index=True)
    ticket_id = db.Column(db.Integer, db.ForeignKey("ticket.id"))
    idempotency_key = db.Column(db.String(255), unique=True, index=True)
    kind = db.Column(db.String(40), nullable=False)
    title = db.Column(db.String(180), nullable=False)
    body = db.Column(db.Text, nullable=False)
    link = db.Column(db.String(300), nullable=False, default="")
    read_at = db.Column(db.DateTime(timezone=True))
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow, index=True)
    recipient = db.relationship("User", back_populates="notifications")

    def to_dict(self):
        return {
            "id": self.id,
            "kind": self.kind,
            "title": self.title,
            "body": self.body,
            "link": self.link,
            "ticket_id": self.ticket_id,
            "read_at": self.read_at.isoformat() if self.read_at else None,
            "created_at": self.created_at.isoformat(),
        }


class ActivityLog(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    actor_id = db.Column(db.Integer, db.ForeignKey("user.id"))
    action = db.Column(db.String(80), nullable=False)
    object_type = db.Column(db.String(80), nullable=False)
    object_id = db.Column(db.String(80), nullable=False)
    summary = db.Column(db.String(500), nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow, index=True)
    actor = db.relationship("User")


class AuditLog(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    actor_id = db.Column(db.Integer, db.ForeignKey("user.id"))
    action = db.Column(db.String(100), nullable=False)
    object_type = db.Column(db.String(80), nullable=False)
    object_id = db.Column(db.String(80), nullable=False)
    details = db.Column(db.JSON, nullable=False, default=dict)
    ip_address = db.Column(db.String(45))
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow, index=True)
    actor = db.relationship("User")
