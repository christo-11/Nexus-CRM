"""Add customer feedback reviews.

Revision ID: 2f4b8d1c6a90
Revises: 1d3a7b9c5e20
Create Date: 2026-10-26 14:24:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = "2f4b8d1c6a90"
down_revision = "1d3a7b9c5e20"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "feedback_review",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("customer_id", sa.Integer(), nullable=True),
        sa.Column("title", sa.String(length=120), nullable=True),
        sa.Column("comment", sa.Text(), nullable=False),
        sa.Column("rating", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=16), server_default="pending", nullable=False),
        sa.Column("display_name", sa.String(length=80), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("moderated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("moderator_id", sa.Integer(), nullable=True),
        sa.CheckConstraint("rating >= 1 AND rating <= 5", name="ck_feedback_review_rating"),
        sa.CheckConstraint(
            "status IN ('pending', 'approved', 'rejected')",
            name="ck_feedback_review_status",
        ),
        sa.ForeignKeyConstraint(["customer_id"], ["user.id"], name="fk_feedback_review_customer", ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["moderator_id"], ["user.id"], name="fk_feedback_review_moderator", ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_feedback_review_customer_id", "feedback_review", ["customer_id"])
    op.create_index(
        "ix_feedback_review_customer_created_at",
        "feedback_review",
        ["customer_id", "created_at"],
    )
    op.create_index(
        "ix_feedback_review_status_created_at",
        "feedback_review",
        ["status", "created_at"],
    )


def downgrade():
    op.drop_index("ix_feedback_review_status_created_at", table_name="feedback_review")
    op.drop_index("ix_feedback_review_customer_created_at", table_name="feedback_review")
    op.drop_index("ix_feedback_review_customer_id", table_name="feedback_review")
    op.drop_table("feedback_review")
