"""Allow meetings to be scheduled from sales leads.

Revision ID: 3a8b2f6d1c40
Revises: 2f4b8d1c6a90
Create Date: 2026-10-30 21:10:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = "3a8b2f6d1c40"
down_revision = "2f4b8d1c6a90"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("meeting") as batch_op:
        batch_op.alter_column(
            "ticket_id",
            existing_type=sa.Integer(),
            nullable=True,
        )
        batch_op.add_column(sa.Column("lead_id", sa.Integer(), nullable=True))
        batch_op.create_index("ix_meeting_lead_id", ["lead_id"])
        batch_op.create_foreign_key(
            "fk_meeting_lead_id_lead",
            "lead",
            ["lead_id"],
            ["id"],
        )
        batch_op.create_check_constraint(
            "ck_meeting_ticket_or_lead",
            "ticket_id IS NOT NULL OR lead_id IS NOT NULL",
        )


def downgrade():
    with op.batch_alter_table("meeting") as batch_op:
        batch_op.drop_constraint("ck_meeting_ticket_or_lead", type_="check")
        batch_op.drop_constraint("fk_meeting_lead_id_lead", type_="foreignkey")
        batch_op.drop_index("ix_meeting_lead_id")
        batch_op.drop_column("lead_id")
        batch_op.alter_column(
            "ticket_id",
            existing_type=sa.Integer(),
            nullable=False,
        )
