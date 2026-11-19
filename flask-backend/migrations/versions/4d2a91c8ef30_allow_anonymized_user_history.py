"""Allow user deletion while preserving anonymized history.

Revision ID: 4d2a91c8ef30
Revises: 3c9f61a2b7d4
Create Date: 2026-10-13 22:55:00.000000
"""
from alembic import op


revision = "4d2a91c8ef30"
down_revision = "3c9f61a2b7d4"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("lead") as batch_op:
        batch_op.alter_column("assigned_to_id", nullable=True)
        batch_op.alter_column("created_by_id", nullable=True)

    with op.batch_alter_table("ticket") as batch_op:
        batch_op.alter_column("customer_id", nullable=True)

    with op.batch_alter_table("ticket_comment") as batch_op:
        batch_op.alter_column("author_id", nullable=True)

    with op.batch_alter_table("ticket_document") as batch_op:
        batch_op.alter_column("uploaded_by_id", nullable=True)

    with op.batch_alter_table("meeting") as batch_op:
        batch_op.alter_column("created_by_id", nullable=True)


def downgrade():
    with op.batch_alter_table("meeting") as batch_op:
        batch_op.alter_column("created_by_id", nullable=False)

    with op.batch_alter_table("ticket_document") as batch_op:
        batch_op.alter_column("uploaded_by_id", nullable=False)

    with op.batch_alter_table("ticket_comment") as batch_op:
        batch_op.alter_column("author_id", nullable=False)

    with op.batch_alter_table("ticket") as batch_op:
        batch_op.alter_column("customer_id", nullable=False)

    with op.batch_alter_table("lead") as batch_op:
        batch_op.alter_column("created_by_id", nullable=False)
        batch_op.alter_column("assigned_to_id", nullable=False)
