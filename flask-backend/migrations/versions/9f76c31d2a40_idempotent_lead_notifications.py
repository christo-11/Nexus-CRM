"""Make workflow notifications idempotent.

Revision ID: 9f76c31d2a40
Revises: 5e8c1a4d2f90
Create Date: 2026-10-14 23:06:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = "9f76c31d2a40"
down_revision = "5e8c1a4d2f90"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("notification") as batch_op:
        batch_op.add_column(sa.Column("idempotency_key", sa.String(length=255), nullable=True))
        batch_op.create_index("ix_notification_idempotency_key", ["idempotency_key"], unique=True)


def downgrade():
    with op.batch_alter_table("notification") as batch_op:
        batch_op.drop_index("ix_notification_idempotency_key")
        batch_op.drop_column("idempotency_key")
