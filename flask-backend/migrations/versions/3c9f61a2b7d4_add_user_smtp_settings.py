"""Add per-user Gmail SMTP settings.

Revision ID: 3c9f61a2b7d4
Revises: 6c4f9b2d1a83
Create Date: 2026-10-13 17:10:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = "3c9f61a2b7d4"
down_revision = "6c4f9b2d1a83"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("user") as batch_op:
        batch_op.add_column(sa.Column("smtp_email", sa.String(length=254), nullable=True))
        batch_op.add_column(sa.Column("smtp_password", sa.String(length=32), nullable=True))


def downgrade():
    with op.batch_alter_table("user") as batch_op:
        batch_op.drop_column("smtp_password")
        batch_op.drop_column("smtp_email")
