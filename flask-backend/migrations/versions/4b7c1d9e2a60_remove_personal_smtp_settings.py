"""Remove per-user Gmail SMTP credentials.

Revision ID: 4b7c1d9e2a60
Revises: 3a8b2f6d1c40
Create Date: 2026-10-30 21:22:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = "4b7c1d9e2a60"
down_revision = "3a8b2f6d1c40"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("user") as batch_op:
        batch_op.drop_column("smtp_password")
        batch_op.drop_column("smtp_email")


def downgrade():
    with op.batch_alter_table("user") as batch_op:
        batch_op.add_column(sa.Column("smtp_email", sa.String(length=254), nullable=True))
        batch_op.add_column(sa.Column("smtp_password", sa.String(length=32), nullable=True))
