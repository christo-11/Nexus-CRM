"""Add product interest and two-level lead review.

Revision ID: 5e8c1a4d2f90
Revises: 4d2a91c8ef30
Create Date: 2026-10-14 20:45:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = "5e8c1a4d2f90"
down_revision = "4d2a91c8ef30"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("notification") as batch_op:
        batch_op.add_column(sa.Column("link", sa.String(length=300), nullable=False, server_default=""))

    with op.batch_alter_table("lead") as batch_op:
        batch_op.add_column(sa.Column("source", sa.String(length=40), nullable=False, server_default="Website Enquiry"))
        batch_op.add_column(sa.Column("customer_requirements", sa.Text(), nullable=False, server_default=""))
        batch_op.add_column(sa.Column("support_verification_notes", sa.Text(), nullable=False, server_default=""))
        batch_op.add_column(sa.Column("customer_interest_status", sa.String(length=24), nullable=False, server_default="AWAITING_RESPONSE"))
        batch_op.add_column(sa.Column("purchase_intent", sa.String(length=24), nullable=False, server_default="UNKNOWN"))
        batch_op.add_column(sa.Column("approval_status", sa.String(length=24), nullable=False, server_default="NOT_SUBMITTED"))
        batch_op.add_column(sa.Column("follow_up_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(sa.Column("support_assigned_to_id", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("support_verified_by_id", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("support_verified_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(sa.Column("submitted_for_approval_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(sa.Column("approved_by_id", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(sa.Column("purchase_verified_by_id", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("purchase_verified_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(sa.Column("purchase_verification_notes", sa.Text(), nullable=False, server_default=""))
        batch_op.add_column(sa.Column("rejection_reason", sa.Text(), nullable=False, server_default=""))
        batch_op.add_column(sa.Column("review_comment", sa.Text(), nullable=False, server_default=""))
        batch_op.add_column(sa.Column("resubmission_count", sa.Integer(), nullable=False, server_default="0"))
        batch_op.create_foreign_key("fk_lead_support_assigned_to", "user", ["support_assigned_to_id"], ["id"], ondelete="SET NULL")
        batch_op.create_foreign_key("fk_lead_support_verified_by", "user", ["support_verified_by_id"], ["id"], ondelete="SET NULL")
        batch_op.create_foreign_key("fk_lead_approved_by", "user", ["approved_by_id"], ["id"], ondelete="SET NULL")
        batch_op.create_foreign_key("fk_lead_purchase_verified_by", "user", ["purchase_verified_by_id"], ["id"], ondelete="SET NULL")
        batch_op.create_index("ix_lead_approval_status", ["approval_status"])
        batch_op.create_index("ix_lead_support_assigned_to_id", ["support_assigned_to_id"])

    op.create_table(
        "product_interest_event",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("product_id", sa.Integer(), sa.ForeignKey("product.id", ondelete="CASCADE"), nullable=False),
        sa.Column("customer_id", sa.Integer(), sa.ForeignKey("user.id", ondelete="SET NULL"), nullable=True),
        sa.Column("session_hash", sa.String(length=64), nullable=False),
        sa.Column("lead_id", sa.Integer(), sa.ForeignKey("lead.id", ondelete="SET NULL"), nullable=True),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("visit_count", sa.Integer(), nullable=False, server_default="1"),
        sa.UniqueConstraint("product_id", "session_hash", name="uq_product_interest_session"),
    )
    op.create_index("ix_product_interest_event_product_id", "product_interest_event", ["product_id"])
    op.create_index("ix_product_interest_event_customer_id", "product_interest_event", ["customer_id"])
    op.create_index("ix_product_interest_event_lead_id", "product_interest_event", ["lead_id"])

    op.create_table(
        "lead_approval_history",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("lead_id", sa.Integer(), sa.ForeignKey("lead.id", ondelete="CASCADE"), nullable=False),
        sa.Column("actor_id", sa.Integer(), sa.ForeignKey("user.id", ondelete="SET NULL"), nullable=True),
        sa.Column("action", sa.String(length=40), nullable=False),
        sa.Column("comment", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_lead_approval_history_lead_id", "lead_approval_history", ["lead_id"])

    op.create_table(
        "lead_communication",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("lead_id", sa.Integer(), sa.ForeignKey("lead.id", ondelete="CASCADE"), nullable=False),
        sa.Column("sender_id", sa.Integer(), sa.ForeignKey("user.id", ondelete="SET NULL"), nullable=True),
        sa.Column("recipient", sa.String(length=254), nullable=False),
        sa.Column("subject", sa.String(length=240), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("delivery_status", sa.String(length=20), nullable=False, server_default="QUEUED"),
        sa.Column("delivery_error", sa.String(length=500), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_lead_communication_lead_id", "lead_communication", ["lead_id"])


def downgrade():
    with op.batch_alter_table("notification") as batch_op:
        batch_op.drop_column("link")

    op.drop_index("ix_lead_communication_lead_id", table_name="lead_communication")
    op.drop_table("lead_communication")
    op.drop_index("ix_lead_approval_history_lead_id", table_name="lead_approval_history")
    op.drop_table("lead_approval_history")
    op.drop_index("ix_product_interest_event_lead_id", table_name="product_interest_event")
    op.drop_index("ix_product_interest_event_customer_id", table_name="product_interest_event")
    op.drop_index("ix_product_interest_event_product_id", table_name="product_interest_event")
    op.drop_table("product_interest_event")
    with op.batch_alter_table("lead") as batch_op:
        batch_op.drop_index("ix_lead_support_assigned_to_id")
        batch_op.drop_index("ix_lead_approval_status")
        batch_op.drop_constraint("fk_lead_approved_by", type_="foreignkey")
        batch_op.drop_constraint("fk_lead_purchase_verified_by", type_="foreignkey")
        batch_op.drop_constraint("fk_lead_support_verified_by", type_="foreignkey")
        batch_op.drop_constraint("fk_lead_support_assigned_to", type_="foreignkey")
        batch_op.drop_column("resubmission_count")
        batch_op.drop_column("review_comment")
        batch_op.drop_column("rejection_reason")
        batch_op.drop_column("approved_at")
        batch_op.drop_column("purchase_verification_notes")
        batch_op.drop_column("purchase_verified_at")
        batch_op.drop_column("purchase_verified_by_id")
        batch_op.drop_column("approved_by_id")
        batch_op.drop_column("submitted_for_approval_at")
        batch_op.drop_column("support_verified_at")
        batch_op.drop_column("support_verified_by_id")
        batch_op.drop_column("support_assigned_to_id")
        batch_op.drop_column("approval_status")
        batch_op.drop_column("follow_up_at")
        batch_op.drop_column("purchase_intent")
        batch_op.drop_column("customer_interest_status")
        batch_op.drop_column("support_verification_notes")
        batch_op.drop_column("customer_requirements")
        batch_op.drop_column("source")
