"""Add enquiry history and active-lead deduplication.

Revision ID: 1d3a7b9c5e20
Revises: 9f76c31d2a40
Create Date: 2026-10-16 20:20:00.000000
"""
import hashlib

from alembic import op
import sqlalchemy as sa


revision = "1d3a7b9c5e20"
down_revision = "9f76c31d2a40"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("lead") as batch_op:
        batch_op.add_column(sa.Column("customer_id", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("dedupe_key", sa.String(length=64), nullable=True))
        batch_op.create_foreign_key(
            "fk_lead_customer", "user", ["customer_id"], ["id"], ondelete="SET NULL",
        )
        batch_op.create_index("ix_lead_customer_id", ["customer_id"])

    connection = op.get_bind()
    leads = connection.execute(sa.text(
        "SELECT id, email, status FROM lead ORDER BY id DESC"
    )).mappings()
    seen_emails = set()
    for lead in leads:
        email = (lead["email"] or "").strip().lower()
        if not email or lead["status"] in {"CONVERTED", "LOST", "DISQUALIFIED"}:
            continue
        if email in seen_emails:
            continue
        seen_emails.add(email)
        key = hashlib.sha256(email.encode("utf-8")).hexdigest()
        connection.execute(
            sa.text("UPDATE lead SET dedupe_key = :key WHERE id = :id"),
            {"key": key, "id": lead["id"]},
        )

    connection.execute(sa.text(
        "UPDATE lead SET customer_id = converted_customer_id "
        "WHERE customer_id IS NULL AND converted_customer_id IS NOT NULL"
    ))
    op.create_index("ix_lead_dedupe_key", "lead", ["dedupe_key"], unique=True)

    op.create_table(
        "enquiry",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("lead_id", sa.Integer(), sa.ForeignKey("lead.id", ondelete="CASCADE"), nullable=False),
        sa.Column("customer_id", sa.Integer(), sa.ForeignKey("user.id", ondelete="SET NULL"), nullable=True),
        sa.Column("product_id", sa.Integer(), sa.ForeignKey("product.id", ondelete="SET NULL"), nullable=True),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("type", sa.String(length=24), nullable=False, server_default="SALES_ENQUIRY"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_enquiry_lead_id", "enquiry", ["lead_id"])
    op.create_index("ix_enquiry_customer_id", "enquiry", ["customer_id"])
    op.create_index("ix_enquiry_product_id", "enquiry", ["product_id"])
    op.create_index("ix_enquiry_type", "enquiry", ["type"])
    op.create_index("ix_enquiry_created_at", "enquiry", ["created_at"])


def downgrade():
    op.drop_index("ix_enquiry_created_at", table_name="enquiry")
    op.drop_index("ix_enquiry_type", table_name="enquiry")
    op.drop_index("ix_enquiry_product_id", table_name="enquiry")
    op.drop_index("ix_enquiry_customer_id", table_name="enquiry")
    op.drop_index("ix_enquiry_lead_id", table_name="enquiry")
    op.drop_table("enquiry")
    op.drop_index("ix_lead_dedupe_key", table_name="lead")
    with op.batch_alter_table("lead") as batch_op:
        batch_op.drop_index("ix_lead_customer_id")
        batch_op.drop_constraint("fk_lead_customer", type_="foreignkey")
        batch_op.drop_column("dedupe_key")
        batch_op.drop_column("customer_id")
