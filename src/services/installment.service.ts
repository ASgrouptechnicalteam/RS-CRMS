import { prisma } from '../lib/prisma';
import { PrismaClient, Installment } from '@prisma/client';
import { TokenPayload } from '../utils/jwt';
import { BookingPolicy } from '../policies/booking.policy';


const p = prisma;

export class AppError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = 'AppError';
  }
}

export class InstallmentService {
  /**
   * Create a new installment schedule for a booking in bulk.
   */
  static async createInstallments(
    user: TokenPayload,
    dto: {
      booking_id: number;
      total_booking_amount: number;
      installments: Array<{
        installment_number: number;
        expected_amount: number;
        due_date: string;
        remarks?: string | null;
      }>;
    }
  ) {
    // 1. Verify booking exists and user has access
    const booking = await p.booking.findFirst({
      where: { id: dto.booking_id, company_id: user.companyId },
    });

    if (!booking) {
      throw new AppError(404, 'Booking not found');
    }

    if (!BookingPolicy.canView(user, booking)) {
      throw new AppError(403, 'You do not have access to this booking');
    }

    // 2. Validate total amount matches booking amount
    if (Math.abs(booking.agreed_price - dto.total_booking_amount) > 0.01) {
      throw new AppError(400, 'Total installment amount does not match the agreed price of the booking');
    }

    try {
      return await p.$transaction(async (tx) => {
        // Delete existing PENDING installments to allow recreation if needed
        await tx.installment.deleteMany({
          where: { booking_id: booking.id, status: 'PENDING' }
        });

        // Create new installments
        const createdInstallments = [];
        for (const inst of dto.installments) {
          const installment = await tx.installment.create({
            data: {
              booking_id: booking.id,
              installment_number: inst.installment_number,
              expected_amount: inst.expected_amount,
              due_date: new Date(inst.due_date),
              remarks: inst.remarks,
              recorded_by_id: user.employeeId,
            },
          });
          createdInstallments.push(installment);
        }

        // Audit log
        await tx.auditEvent.create({
          data: {
            actor_id: user.employeeId,
            action: 'INSTALLMENTS_CREATED',
            entity_type: 'Booking',
            entity_id: booking.id,
            new_value: JSON.stringify({ count: dto.installments.length, total: dto.total_booking_amount }),
          },
        });

        return createdInstallments;
      });
    } catch (error: any) {
      if (error.code === 'P2002') {
        throw new AppError(409, 'An installment with this number already exists for this booking');
      }
      throw error;
    }
  }

  /**
   * Retrieve installments for a booking with lazy OVERDUE evaluation.
   */
  static async getInstallments(user: TokenPayload, bookingId: number) {
    const booking = await p.booking.findFirst({
      where: { id: bookingId, company_id: user.companyId },
    });

    if (!booking) {
      throw new AppError(404, 'Booking not found');
    }

    if (!BookingPolicy.canView(user, booking)) {
      throw new AppError(403, 'You do not have access to this booking');
    }

    const installments = await p.installment.findMany({
      where: { booking_id: booking.id },
      orderBy: { installment_number: 'asc' },
      include: {
        recorded_by: { select: { id: true, full_name: true } },
      },
    });

    const now = new Date();

    // Lazy OVERDUE mapping
    return installments.map((inst: any) => {
      let mappedStatus = inst.status;
      
      if (inst.status === 'PENDING' && new Date(inst.due_date) < now) {
        mappedStatus = 'OVERDUE';
      }

      return {
        ...inst,
        status: mappedStatus,
      };
    });
  }
}
