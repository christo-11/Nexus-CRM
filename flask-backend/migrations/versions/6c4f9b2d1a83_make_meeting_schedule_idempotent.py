"""Make meeting scheduling idempotent.

Revision ID: 6c4f9b2d1a83
Revises: 0aa23c3787f9
Create Date: 2026-10-13 11:35:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = "6c4f9b2d1a83"
down_revision = "0aa23c3787f9"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("meeting") as batch_op:
        batch_op.add_column(sa.Column("request_key", sa.String(length=64), nullable=True))
    op.execute("UPDATE meeting SET request_key = 'legacy:' || CAST(id AS VARCHAR)")
    with op.batch_alter_table("meeting") as batch_op:
        batch_op.create_unique_constraint("uq_meeting_request_key", ["request_key"])


def downgrade():
    with op.batch_alter_table("meeting") as batch_op:
        batch_op.drop_constraint("uq_meeting_request_key", type_="unique")
        batch_op.drop_column("request_key")
